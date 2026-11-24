import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as readline from 'node:readline';
import type { LocalVoice, SpeechSettings, SpeechState } from '../shared/speech.js';
import { normalizeSpeechSettings, prepareSpeech } from '../shared/speech.js';

export const LOCAL_SPEECH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  $raw = $env:DESKTOP_PET_TTS_REQUEST
  if ([string]::IsNullOrWhiteSpace($raw)) { $raw = [Console]::In.ReadToEnd() }
  $request = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($raw)) | ConvertFrom-Json
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $voices = @([Windows.Media.SpeechSynthesis.SpeechSynthesizer,Windows.Media.SpeechSynthesis,ContentType=WindowsRuntime]::AllVoices)
  if ($request.mode -eq 'voices') {
    $items = @($voices | ForEach-Object { [pscustomobject]@{ name=$_.DisplayName; language=$_.Language; gender=$_.Gender.ToString() } })
    $payload = [pscustomobject]@{ type='voices'; voices=$items }
    Write-Output ($payload | ConvertTo-Json -Compress -Depth 5)
  } else {
  $wanted = [string]$request.voiceName
  $voice = $voices | Where-Object { $_.DisplayName -eq $wanted } | Select-Object -First 1
  if (-not $voice) { $voice = $voices | Where-Object { $_.Language -like 'zh-*' -and $_.Gender.ToString() -eq 'Female' } | Select-Object -First 1 }
  if (-not $voice) { $voice = $voices | Where-Object { $_.Language -like 'zh-*' } | Select-Object -First 1 }
  if (-not $voice) { throw 'NO_CHINESE_VOICE' }
  $synth = [Windows.Media.SpeechSynthesis.SpeechSynthesizer,Windows.Media.SpeechSynthesis,ContentType=WindowsRuntime]::new()
  $synth.Voice = $voice
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*' } | Select-Object -First 1
  $streamType = ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream,Windows.Media.SpeechSynthesis,ContentType=WindowsRuntime])
  $segments = @($request.segments)
  for ($i = 0; $i -lt $segments.Count; $i++) {
    $segment = $segments[$i]
    $synth.Options.SpeakingRate = 1.0 + ([double]$segment.rate * 0.08)
    $synth.Options.AudioVolume = [double]$segment.volume / 100.0
    $operation = $synth.SynthesizeTextToStreamAsync([string]$segment.text)
    $task = $asTask.MakeGenericMethod($streamType).Invoke($null, @($operation))
    $audio = $task.GetAwaiter().GetResult()
    $input = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($audio.GetInputStreamAt(0))
    $memory = New-Object System.IO.MemoryStream
    $input.CopyTo($memory)
    $memory.Position = 0
    if ($memory.Length -le 44) { throw 'EMPTY_AUDIO' }
    Write-Output (([pscustomobject]@{ type='speaking'; remaining=$segments.Count-$i-1; voiceName=$voice.DisplayName; bytes=$memory.Length }) | ConvertTo-Json -Compress)
    if (-not [bool]$request.silent) {
      $player = New-Object System.Media.SoundPlayer
      $player.Stream = $memory
      $player.Load()
      $player.PlaySync()
      $player.Dispose()
    }
    $memory.Dispose(); $input.Dispose(); $audio.Dispose()
    if (-not [bool]$request.silent -and $i -lt $segments.Count - 1) { Start-Sleep -Milliseconds ([int]$segment.pauseMs) }
  }
  Write-Output '{"type":"done"}'
  }
} catch {
  if ($_.Exception.Message -eq 'NO_CHINESE_VOICE') { $code = 'NO_CHINESE_VOICE' } else { $code = 'SPEECH_FAILED' }
  Write-Output (([pscustomobject]@{ type='error'; code=$code }) | ConvertTo-Json -Compress)
  exit 1
} finally {
  if ($synth) { $synth.Dispose() }
}
`;

function startWorker(request: Record<string, unknown>): ChildProcessWithoutNullStreams {
  const command = Buffer.from(LOCAL_SPEECH_SCRIPT, 'utf16le').toString('base64');
  const payload = Buffer.from(JSON.stringify(request), 'utf16le').toString('base64');
  const powershell = process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe';
  const child = spawn(powershell, ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',command], { windowsHide:true, stdio:'pipe', env: { ...process.env, DESKTOP_PET_TTS_REQUEST: payload } });
  child.stdin.end(payload);
  return child;
}

export async function listLocalVoices(): Promise<{ voices: LocalVoice[]; error?: string }> {
  if (process.platform !== 'win32') return { voices: [], error: '仅支持 Windows 本地语音' };
  return new Promise((resolve) => {
    let settled = false; let timer: NodeJS.Timeout | undefined;
    const child = startWorker({ mode:'voices' });
    const finish = (voices: LocalVoice[], error?: string) => { if (settled) return; settled=true; if (timer) clearTimeout(timer); resolve({ voices, ...(error ? { error } : {}) }); };
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => { try { const msg=JSON.parse(line) as {type?:string;voices?:LocalVoice[]}; if (msg.type==='voices') finish(Array.isArray(msg.voices) ? msg.voices : []); else if (msg.type==='error') finish([], '读取 Windows 本地语音失败'); } catch {} });
    child.on('error', () => finish([], '无法启动 Windows 本地语音'));
    child.on('close', (code) => { if (!settled) finish([], code===0 ? '未读取到本地语音' : '读取 Windows 本地语音失败'); lines.close(); });
    timer = setTimeout(() => { try { child.kill(); } catch {} finish([], '读取本地语音超时'); }, 15000);
  });
}

export class LocalSpeech {
  private child: ChildProcessWithoutNullStreams | null = null;
  private run = 0;
  private timer: NodeJS.Timeout | undefined;
  constructor(private readonly notify: (state: SpeechState) => void) {}
  stop(): void { this.run += 1; if (this.timer) clearTimeout(this.timer); this.timer=undefined; const old=this.child; this.child=null; try { old?.kill(); } catch {} this.notify({state:'idle',remaining:0}); }
  speak(rawText:string, settings?:SpeechSettings, options?:{silent?:boolean}):boolean {
    if (process.platform!=='win32' || typeof rawText!=='string') return false;
    const cfg=normalizeSpeechSettings(settings); const segments=prepareSpeech(rawText,cfg); if (!segments.length) return false;
    this.stop(); const run=this.run; const child=startWorker({mode:'speak',voiceName:cfg.voiceName,segments,silent:options?.silent === true}); this.child=child; this.notify({state:'preparing',remaining:segments.length});
    const lines=readline.createInterface({input:child.stdout});
    const finish=(state:SpeechState)=>{if(this.child!==child||this.run!==run)return;this.child=null;if(this.timer)clearTimeout(this.timer);this.timer=undefined;lines.close();this.notify(state)};
    const arm=()=>{if(this.timer)clearTimeout(this.timer);this.timer=setTimeout(()=>finish({state:'error',remaining:0,error:'朗读超时'}),90000)}; arm();
    lines.on('line',(line)=>{try{const msg=JSON.parse(line) as {type?:string;remaining?:number;voiceName?:string;code?:string};if(msg.type==='speaking'){arm();this.notify({state:'speaking',remaining:msg.remaining??0,voiceName:msg.voiceName})}else if(msg.type==='done'){finish({state:'idle',remaining:0})}else if(msg.type==='error'){finish({state:'error',remaining:0,error:msg.code==='NO_CHINESE_VOICE'?'未找到中文 Windows 女声，请安装中文语音包。':'Windows 本地语音合成失败。'})}}catch{}});
    child.on('error',()=>finish({state:'error',remaining:0,error:'无法启动 Windows 本地语音。'})); child.on('close',(code)=>{if(code!==0&&this.child===child)finish({state:'error',remaining:0,error:'Windows 本地语音进程已退出。'})}); return true;
  }
}

























