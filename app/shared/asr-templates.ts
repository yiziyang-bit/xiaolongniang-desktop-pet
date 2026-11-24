/**
 * 语音识别（ASR / Speech-to-Text）API 预设与 16kHz 单声道 WAV 编码工具。
 *
 * 所有云端/本地接口均采用 OpenAI 兼容的 `POST {baseURL}/audio/transcriptions`（multipart/form-data）。
 */

export type SpeechAsrMode = 'local' | 'api';

export interface SpeechAsrConfig {
  /** 识别模式：'local' 使用本地离线 Vosk 模型；'api' 调用云端/自建语音识别接口 */
  mode: SpeechAsrMode;
  /** OpenAI 兼容 Base URL（如 https://api.siliconflow.cn/v1），留空时复用当前对话 AI 的 Base URL */
  baseURL: string;
  /** API Key（主进程通过 safeStorage 加密保存），留空且同源时自动回退当前对话 AI 的 API Key */
  apiKey: string;
  /** 语音识别模型名（如 FunAudioLLM/SenseVoiceSmall、whisper-1、gpt-4o-mini-transcribe） */
  model: string;
  /** 可选语言代码（如 'zh'、'en'，空串表示自动检测） */
  language?: string;
}

export interface AsrTemplate {
  id: string;
  name: string;
  baseURL: string;
  models: string[];
  applyUrl?: string;
  note?: string;
}

export const ASR_TEMPLATES: AsrTemplate[] = [
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow（推荐）',
    baseURL: 'https://api.siliconflow.cn/v1',
    models: ['FunAudioLLM/SenseVoiceSmall', 'TeleAI/TeleSpeechASR'],
    applyUrl: 'https://cloud.siliconflow.cn/account/ak',
    note: 'SenseVoiceSmall 中文/中英混合识别快且准',
  },
  {
    id: 'openai',
    name: 'OpenAI 官方 / 兼容中转',
    baseURL: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'],
    applyUrl: 'https://platform.openai.com/api-keys',
    note: '标准 OpenAI /v1/audio/transcriptions 协议',
  },
  {
    id: 'groq',
    name: 'Groq Whisper 极速',
    baseURL: 'https://api.groq.com/openai/v1',
    models: ['whisper-large-v3-turbo', 'whisper-large-v3'],
    applyUrl: 'https://console.groq.com/keys',
    note: '低延迟 Whisper 大模型识别',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM-ASR',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-asr'],
    applyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    note: '智谱开放平台语音转文字接口',
  },
  {
    id: 'local_whisper',
    name: '本地 Whisper 服务（Faster-Whisper / LocalAI）',
    baseURL: 'http://127.0.0.1:8000/v1',
    models: ['whisper-1', 'Systran/faster-whisper-small'],
    note: '本地 OpenAI 兼容语音服务，可不填 API Key',
  },
];

/** 计算单帧 PCM 的均方根能量（用于前端语音活动检测 VAD）。 */
export function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}

/** 将多段 Float32 PCM 合并并重采样编码为 16-bit 单声道标准 WAV（默认 16kHz）。 */
export function encodeMonoWav16(
  chunks: Float32Array[] | Float32Array,
  inputSampleRate: number,
  targetSampleRate: number = 16000,
): Uint8Array {
  const list = Array.isArray(chunks) ? chunks : [chunks];
  let totalIn = 0;
  for (const c of list) totalIn += c.length;

  const merged = new Float32Array(totalIn);
  let offset = 0;
  for (const c of list) {
    merged.set(c, offset);
    offset += c.length;
  }

  const inRate = Number.isFinite(inputSampleRate) && inputSampleRate > 0 ? inputSampleRate : targetSampleRate;
  const outRate = Number.isFinite(targetSampleRate) && targetSampleRate > 0 ? Math.round(targetSampleRate) : 16000;

  let resampled: Float32Array;
  if (Math.round(inRate) === outRate || merged.length === 0) {
    resampled = merged;
  } else {
    const ratio = inRate / outRate;
    const outLen = Math.max(1, Math.round(merged.length / ratio));
    resampled = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(merged.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
      let acc = 0;
      for (let j = start; j < end; j++) acc += merged[j];
      resampled[i] = acc / (end - start);
    }
  }

  const dataByteLen = resampled.length * 2;
  const buf = new ArrayBuffer(44 + dataByteLen);
  const view = new DataView(buf);

  const writeAscii = (pos: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(pos + i, str.charCodeAt(i));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataByteLen, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // AudioFormat = 1 (PCM)
  view.setUint16(22, 1, true); // NumChannels = 1 (mono)
  view.setUint32(24, outRate, true); // SampleRate
  view.setUint32(28, outRate * 2, true); // ByteRate = SampleRate * BlockAlign
  view.setUint16(32, 2, true); // BlockAlign = 1 * 2
  view.setUint16(34, 16, true); // BitsPerSample = 16
  writeAscii(36, 'data');
  view.setUint32(40, dataByteLen, true);

  let p = 44;
  for (let i = 0; i < resampled.length; i++) {
    const clamped = Math.max(-1, Math.min(1, resampled[i]));
    const s16 = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    view.setInt16(p, s16, true);
    p += 2;
  }

  return new Uint8Array(buf);
}

/** 生成一段极短静音 WAV，用于设置面板「测试接口」验证连通性、API Key 与模型名。 */
export function createSilentWav16(durationMs: number = 350, sampleRate: number = 16000): Uint8Array {
  const count = Math.max(160, Math.round((sampleRate * durationMs) / 1000));
  return encodeMonoWav16(new Float32Array(count), sampleRate, sampleRate);
}
