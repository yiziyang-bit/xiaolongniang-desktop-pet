import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { SpeechSegment, SpeechSettings, SpeechState } from '../shared/speech.js';
import { normalizeSpeechSettings, prepareSpeech } from '../shared/speech.js';

export interface CloneSpeechStatus {
  available: boolean;
  reason: string;
  root?: string;
}

interface CloneAssets {
  root: string;
  python: string;
  cpuPackages: string;
  sitePackages: string;
  model: string;
  vocoder: string;
  reference: string;
  referenceText: string;
}

interface CloneRequest {
  type: 'synthesize';
  id: string;
  text: string;
  outputPath: string;
  speed: number;
  volume: number;
  nfeStep: number;
}

interface CloneMessage {
  type?: string;
  id?: string;
  code?: string;
  message?: string;
}

interface PendingSpeech {
  run: number;
  rawText: string;
  allowFallback: boolean;
  segments: SpeechSegment[];
  index: number;
  settings: Required<SpeechSettings>;
}

const CLONE_VOICE_NAME = 'F5-TTS 克隆声';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

function existingFile(...candidates: Array<string | undefined>): string | undefined {
  return candidates.find((candidate): candidate is string => {
    if (!candidate) return false;
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  });
}

function existingDirectory(...candidates: Array<string | undefined>): string | undefined {
  return candidates.find((candidate): candidate is string => {
    if (typeof candidate !== 'string') return false;
    try { return fs.statSync(candidate).isDirectory(); } catch { return false; }
  });
}

function resolveAssets(settings: Required<SpeechSettings>): CloneAssets | string {
  if (process.platform !== 'win32') return '本地克隆语音目前支持 Windows。';
  const selectedRoot = settings.cloneRoot || process.env.CLONE_TTS_ROOT;
  if (!selectedRoot) return '请选择本机 F5-TTS 资源文件夹。';
  const root = path.isAbsolute(selectedRoot) ? existingDirectory(selectedRoot) : undefined;
  if (!root) return '无法读取所选资源文件夹。';

  const python = existingFile(process.env.CLONE_TTS_PYTHON, path.join(root, 'venv', 'Scripts', 'python.exe'));
  const sitePackages = existingDirectory(process.env.CLONE_TTS_SITE_PACKAGES, path.join(root, 'venv', 'Lib', 'site-packages'));
  const cpuPackages = existingDirectory(process.env.CLONE_TTS_CPU_PACKAGES, path.join(root, 'cpu-pkg')) ?? sitePackages;
  const model = existingFile(process.env.CLONE_TTS_MODEL, path.join(root, 'model_1250000.safetensors'));
  const vocoder = existingDirectory(process.env.CLONE_TTS_VOCODER, path.join(root, 'vocos'));
  const reference = existingFile(process.env.CLONE_TTS_REFERENCE, path.join(root, 'reference.wav'));
  const referenceText = settings.cloneReferenceText || process.env.CLONE_TTS_REFERENCE_TEXT?.trim();

  if (!python || !sitePackages || !cpuPackages || !existingDirectory(path.join(sitePackages, 'f5_tts'))) {
    return '缺少安装了 F5-TTS 的 Python 虚拟环境。';
  }
  if (!model || !vocoder || !existingFile(path.join(vocoder, 'config.yaml'), path.join(vocoder, 'config.json'))) {
    return '缺少 F5-TTS 模型文件或 Vocos 声码器目录。';
  }
  if (!reference || !referenceText) return '请准备 reference.wav，并填写对应的逐字稿。';
  return { root, cpuPackages, sitePackages, python, model, vocoder, reference, referenceText };
}

function powershellPath(): string {
  return process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
}

function quotePowerShell(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * 常驻本地 F5-TTS worker。模型只加载一次，任意回复文本都在本机合成为 WAV，
 * 再由主进程用 SoundPlayer 播放；渲染进程和云端都不会接触音频/文本。
 */
export class CloneSpeech {
  private assets: CloneAssets | null = null;
  private worker: ChildProcessWithoutNullStreams | null = null;
  private workerReady = false;
  private workerBusy = false;
  private workerRequestId: string | null = null;
  private workerRequestRun: number | null = null;
  private workerOutputPath: string | null = null;
  private readyPromise: Promise<boolean> | null = null;
  private readyResolve: ((ready: boolean) => void) | null = null;
  private pending: PendingSpeech | null = null;
  private playback: ChildProcess | null = null;
  private pauseTimer: NodeJS.Timeout | undefined;
  private timeout: NodeJS.Timeout | undefined;
  private startupTimeout: NodeJS.Timeout | undefined;
  private run = 0;
  private device: 'cpu' | 'cuda' = 'cpu';
  private readonly outputDir = path.join(os.tmpdir(), 'desktop-pet-clone-tts');

  constructor(
    private readonly notify: (state: SpeechState) => void,
    private readonly fallback?: (text: string, settings: SpeechSettings) => void,
  ) {}

  status(settings?: SpeechSettings): CloneSpeechStatus {
    const assets = resolveAssets(normalizeSpeechSettings(settings));
    if (typeof assets === 'string') return { available: false, reason: assets };
    return { available: true, reason: '已找到所需文件。可试听验证本机推理环境。', root: assets.root };
  }

  stop(): void {
    this.run += 1;
    this.pending = null;
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pauseTimer = undefined;
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = undefined;
    const playback = this.playback;
    this.playback = null;
    try { playback?.kill(); } catch { /* 已结束 */ }
    // 正在推理的请求让 worker 自然完成；返回的旧音频会被丢弃，避免重复载入 1.35GB 模型。
    this.notify({ state: 'idle', remaining: 0, voiceName: CLONE_VOICE_NAME });
  }

  dispose(): void {
    this.stop();
    const worker = this.worker;
    this.worker = null;
    this.workerReady = false;
    this.workerBusy = false;
    this.workerRequestId = null;
    this.workerRequestRun = null;
    this.removeFile(this.workerOutputPath);
    this.workerOutputPath = null;
    this.finishReady(false);
    try { worker?.stdin.write(`${JSON.stringify({ type: 'stop' })}\n`, 'utf8'); } catch { /* ignore */ }
    try { worker?.kill(); } catch { /* ignore */ }
  }

  speak(rawText: string, settings?: SpeechSettings, options?: { allowFallback?: boolean }): boolean {
    if (process.platform !== 'win32' || typeof rawText !== 'string') return false;
    const cfg = normalizeSpeechSettings(settings);
    const assets = resolveAssets(cfg);
    if (typeof assets === 'string') return false;
    const segments = prepareSpeech(rawText, cfg);
    if (!segments.length) return false;
    const device = cfg.cloneDevice === 'cuda' && process.env.CLONE_TTS_ALLOW_CUDA === '1' ? 'cuda' : 'cpu';
    if (JSON.stringify(assets) !== JSON.stringify(this.assets) || device !== this.device) this.dispose();
    else this.stop();
    this.assets = assets;
    this.device = device;
    const run = this.run;
    this.pending = { run, rawText, allowFallback: options?.allowFallback !== false, segments, index: 0, settings: cfg };
    this.notify({ state: 'preparing', remaining: segments.length, voiceName: CLONE_VOICE_NAME });
    void this.ensureWorker().then((ready) => {
      if (!ready) {
        const failed = this.pending;
        if (failed?.run === run) {
          this.pending = null;
          this.notify({ state: 'error', remaining: 0, voiceName: CLONE_VOICE_NAME, error: '本地克隆模型启动失败，请在设置中切换 Windows 本地语音。' });
          if (failed.allowFallback) this.fallback?.(failed.rawText, failed.settings);
        }
        return;
      }
      this.sendNext();
    });
    return true;
  }

  private ensureWorker(): Promise<boolean> {
    if (this.worker && this.workerReady) return Promise.resolve(true);
    if (this.readyPromise) return this.readyPromise;
    if (!this.assets) return Promise.resolve(false);

    const readyPromise = new Promise<boolean>((resolve) => { this.readyResolve = resolve; });
    this.readyPromise = readyPromise;
    const workerPath = existingFile(
      path.join(process.resourcesPath ?? '', 'scripts', 'clone-tts-worker.py'),
      path.resolve(MODULE_DIR, '..', 'scripts', 'clone-tts-worker.py'),
      path.resolve(process.cwd(), 'scripts', 'clone-tts-worker.py'),
    );
    if (!workerPath) {
      this.finishReady(false);
      return readyPromise;
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CLONE_TTS_ROOT: this.assets.root,
      CLONE_TTS_CPU_PACKAGES: this.assets.cpuPackages,
      CLONE_TTS_SITE_PACKAGES: this.assets.sitePackages,
      CLONE_TTS_MODEL: this.assets.model,
      CLONE_TTS_VOCODER: this.assets.vocoder,
      CLONE_TTS_REFERENCE: this.assets.reference,
      CLONE_TTS_REFERENCE_TEXT: this.assets.referenceText,
      CLONE_TTS_DEVICE: this.device,
      HF_HUB_OFFLINE: '1',
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
    };
    try {
      const child = spawn(this.assets.python, [workerPath], { windowsHide: true, stdio: 'pipe', env });
      this.worker = child;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => console.warn('[clone-tts]', String(chunk).trim().slice(-1000)));
      const lines = readline.createInterface({ input: child.stdout });
      lines.on('line', (line) => { if (this.worker === child) this.onWorkerLine(line); });
      child.once('error', (error) => {
        if (this.worker !== child) return;
        console.warn('[clone-tts] worker start failed:', error.message);
        this.finishReady(false);
      });
      child.once('close', (code) => {
        lines.close();
        if (this.worker !== child) return;
        const hadReady = this.workerReady;
        this.worker = null;
        this.workerReady = false;
        this.workerBusy = false;
        this.removeFile(this.workerOutputPath);
        this.workerOutputPath = null;
        this.workerRequestId = null;
        this.workerRequestRun = null;
        this.finishReady(false);
        const failed = this.pending;
        if (hadReady && failed) {
          this.pending = null;
          this.notify({ state: 'error', remaining: 0, voiceName: CLONE_VOICE_NAME, error: `本地克隆语音进程已退出（${code ?? '未知'}）。` });
          if (failed.allowFallback && failed.index <= 1) this.fallback?.(failed.rawText, failed.settings);
        }
      });
      this.startupTimeout = setTimeout(() => {
        if (this.worker !== child || this.workerReady) return;
        this.worker = null;
        this.finishReady(false);
        try { child.kill(); } catch { /* 已退出 */ }
      }, 120_000);
    } catch (error) {
      console.warn('[clone-tts] worker spawn failed:', (error as Error).message);
      this.finishReady(false);
    }
    return readyPromise;
  }

  private finishReady(ready: boolean): void {
    if (this.startupTimeout) clearTimeout(this.startupTimeout);
    this.startupTimeout = undefined;
    const resolve = this.readyResolve;
    this.readyResolve = null;
    this.readyPromise = null;
    if (resolve) resolve(ready);
  }

  private onWorkerLine(line: string): void {
    let message: CloneMessage;
    try { message = JSON.parse(line) as CloneMessage; } catch { return; }
    if (message.type === 'ready') {
      this.workerReady = true;
      this.finishReady(true);
      return;
    }
    if (message.type === 'audio') {
      this.onAudio(message);
      return;
    }
    if (message.type === 'error') {
      if (!this.workerReady) {
        console.warn('[clone-tts] worker init failed:', message.message || message.code || 'unknown');
        return;
      }
      const isCurrent = this.workerRequestRun === this.pending?.run;
      this.workerBusy = false;
      this.workerRequestId = null;
      this.workerRequestRun = null;
      this.removeFile(this.workerOutputPath);
      this.workerOutputPath = null;
      if (this.timeout) clearTimeout(this.timeout);
      this.timeout = undefined;
      if (!isCurrent) {
        this.sendNext();
        return;
      }
      const pending = this.pending;
      this.pending = null;
      if (pending) {
        this.notify({ state: 'error', remaining: 0, voiceName: CLONE_VOICE_NAME, error: message.message || '本地克隆语音合成失败。' });
        if (pending.allowFallback && pending.index <= 1) this.fallback?.(pending.rawText, pending.settings);
      }
    }
  }

  private sendNext(): void {
    const pending = this.pending;
    if (!pending || pending.run !== this.run || !this.worker || !this.workerReady || this.workerBusy) return;
    if (pending.index >= pending.segments.length) {
      this.pending = null;
      this.notify({ state: 'idle', remaining: 0, voiceName: CLONE_VOICE_NAME });
      return;
    }
    const segment = pending.segments[pending.index];
    pending.index += 1;
    const requestId = `${pending.run}-${randomUUID()}`;
    const outputPath = path.join(this.outputDir, `${requestId}.wav`);
    this.workerBusy = true;
    this.workerRequestId = requestId;
    this.workerRequestRun = pending.run;
    this.workerOutputPath = outputPath;
    const request: CloneRequest = {
      type: 'synthesize',
      id: requestId,
      text: segment.text,
      outputPath,
      speed: Math.max(0.75, Math.min(1.35, 1 + segment.rate * 0.06)),
      volume: segment.volume,
      nfeStep: 16,
    };
    try {
      this.worker.stdin.write(`${JSON.stringify(request)}\n`, 'utf8');
      if (this.timeout) clearTimeout(this.timeout);
      this.timeout = setTimeout(() => {
        this.workerBusy = false;
        this.pending = null;
        this.notify({ state: 'error', remaining: 0, voiceName: CLONE_VOICE_NAME, error: '本地克隆语音合成超时。' });
      }, 180_000);
    } catch (error) {
      this.workerBusy = false;
      this.pending = null;
      this.notify({ state: 'error', remaining: 0, voiceName: CLONE_VOICE_NAME, error: `无法发送克隆语音请求：${(error as Error).message}` });
    }
  }

  private onAudio(message: CloneMessage): void {
    if (message.id !== this.workerRequestId) return;
    const outputPath = this.workerOutputPath;
    const current = this.pending;
    const isCurrent = current?.run === this.workerRequestRun;
    this.workerBusy = false;
    this.workerRequestId = null;
    this.workerRequestRun = null;
    this.workerOutputPath = null;
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = undefined;
    if (!isCurrent || !outputPath || !fs.existsSync(outputPath)) {
      this.removeFile(outputPath);
      this.sendNext();
      return;
    }
    this.playAudio(outputPath, current as PendingSpeech);
  }

  private playAudio(outputPath: string, pending: PendingSpeech): void {
    const script = `$ErrorActionPreference='Stop'; $p=New-Object System.Media.SoundPlayer; $p.SoundLocation='${quotePowerShell(outputPath)}'; $p.Load(); $p.PlaySync(); $p.Dispose();`;
    let settled = false;
    const player = spawn(powershellPath(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, stdio: 'ignore' });
    this.playback = player;
    player.once('error', (error) => {
      if (settled) return;
      settled = true;
      this.playback = null;
      this.removeFile(outputPath);
      if (pending.run === this.run) {
        this.pending = null;
        this.notify({ state: 'error', remaining: 0, voiceName: CLONE_VOICE_NAME, error: `播放克隆语音失败：${error.message}` });
      }
    });
    player.once('close', () => {
      if (settled) return;
      settled = true;
      this.playback = null;
      this.removeFile(outputPath);
      if (pending.run !== this.run || this.pending !== pending) return;
      if (pending.index >= pending.segments.length) {
        this.pending = null;
        this.notify({ state: 'idle', remaining: 0, voiceName: CLONE_VOICE_NAME });
        return;
      }
      this.pauseTimer = setTimeout(() => {
        this.pauseTimer = undefined;
        this.sendNext();
      }, pending.segments[pending.index - 1]?.pauseMs ?? 150);
    });
    this.notify({ state: 'speaking', remaining: Math.max(0, pending.segments.length - pending.index), voiceName: CLONE_VOICE_NAME });
  }

  private removeFile(file: string | null | undefined): void {
    if (!file) return;
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch { /* 播放器可能仍持有文件，稍后由系统清理 */ }
  }
}

