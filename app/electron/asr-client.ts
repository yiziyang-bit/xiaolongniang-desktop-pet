import { net } from 'electron';
import { StringDecoder } from 'node:string_decoder';
import { loadConfig, type AppConfig, type SpeechAsrConfig } from './config-store.js';
import { createSilentWav16 } from '../shared/asr-templates.js';

const ASR_TIMEOUT_MS = 45_000;
const activeAsrRequests = new Map<string, AbortController>();

export function cancelAsr(reqId?: string): boolean {
  if (!reqId) {
    cancelAllAsr();
    return true;
  }
  const ctrl = activeAsrRequests.get(reqId);
  if (!ctrl) return false;
  activeAsrRequests.delete(reqId);
  ctrl.abort();
  return true;
}

export function cancelAllAsr(): void {
  const list = Array.from(activeAsrRequests.values());
  activeAsrRequests.clear();
  for (const ctrl of list) ctrl.abort();
}

function normalizeOriginBase(raw: string): string {
  return raw.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '').replace(/\/audio\/transcriptions$/i, '');
}

function isLocalEndpoint(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1';
  } catch {
    return false;
  }
}

/** 将用户填写的 Base URL 规范化为完整的 `/audio/transcriptions` 地址并校验协议。 */
export function resolveAsrEndpointUrl(rawBaseURL: string): string {
  const trimmed = rawBaseURL.trim();
  if (!trimmed) {
    throw new Error('请先在「设置 → 语音输入 → 语音识别模型」中填写 API 地址（Base URL）。');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`语音识别 API 地址格式无效：${trimmed}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('语音识别 API 地址仅支持 http:// 或 https:// 协议。');
  }

  const noSlash = trimmed.replace(/\/+$/, '');
  if (/\/audio\/transcriptions$/i.test(noSlash)) {
    return noSlash;
  }
  if (/\/chat\/completions$/i.test(noSlash)) {
    return noSlash.replace(/\/chat\/completions$/i, '/audio/transcriptions');
  }
  return `${noSlash}/audio/transcriptions`;
}

/** 合并语音识别配置；当用户留空 Base URL（或与对话 AI 同源且留空 Key）时安全复用对话 AI 的地址/密钥。 */
export function resolveEffectiveAsrConfig(
  cfg: Pick<AppConfig, 'baseURL' | 'apiKey' | 'speechAsr'>,
  override?: Partial<SpeechAsrConfig>,
): { endpointUrl: string; apiKey: string; model: string; language: string } {
  const saved = cfg.speechAsr;
  const rawBase = (override?.baseURL ?? saved?.baseURL ?? '').trim() || (cfg.baseURL ?? '').trim();
  const endpointUrl = resolveAsrEndpointUrl(rawBase);

  const explicitKey = (override?.apiKey ?? saved?.apiKey ?? '').trim();
  const sameOriginAsChat =
    !!cfg.baseURL && normalizeOriginBase(rawBase) === normalizeOriginBase(cfg.baseURL);
  const apiKey = explicitKey || (sameOriginAsChat ? (cfg.apiKey ?? '').trim() : '');

  if (!apiKey && !isLocalEndpoint(endpointUrl)) {
    throw new Error('请先填写语音识别 API Key（若使用本地无鉴权服务，请填 127.0.0.1 或 localhost 地址）。');
  }

  const model = (override?.model ?? saved?.model ?? '').trim();
  if (!model) {
    throw new Error('请先填写或选择语音识别模型名称（例如 FunAudioLLM/SenseVoiceSmall 或 whisper-1）。');
  }

  const language = (override?.language ?? saved?.language ?? '').trim();
  return { endpointUrl, apiKey, model, language };
}

/** 构造标准 `multipart/form-data` 请求体（无第三方依赖）。 */
export function buildAsrMultipartBody(
  wavBytes: Uint8Array,
  fields: Record<string, string>,
  boundary: string,
): Buffer {
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    if (!value) continue;
    const safeName = name.replace(/["\r\n]/g, '');
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${safeName}"\r\n\r\n${value}\r\n`,
        'utf8',
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="speech.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
      'utf8',
    ),
  );
  parts.push(Buffer.from(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return Buffer.concat(parts);
}

/** 解析 `/audio/transcriptions` 响应体（兼容 JSON `{ text }` 与纯文本返回）。 */
export function parseAsrResponse(statusCode: number, rawBody: string): string {
  const trimmed = rawBody.trim();
  if (statusCode < 200 || statusCode >= 300) {
    let detail = trimmed;
    try {
      const parsed = JSON.parse(trimmed) as {
        error?: { message?: string } | string;
        message?: string;
        detail?: string;
      };
      if (typeof parsed.error === 'string') detail = parsed.error;
      else if (parsed.error && typeof parsed.error.message === 'string') detail = parsed.error.message;
      else if (typeof parsed.message === 'string') detail = parsed.message;
      else if (typeof parsed.detail === 'string') detail = parsed.detail;
    } catch {
      // 保留原始文本摘要
    }
    const shortDetail = detail.length > 240 ? `${detail.slice(0, 240)}…` : detail;
    throw new Error(`语音识别接口返回 HTTP ${statusCode}${shortDetail ? `：${shortDetail}` : ''}`);
  }

  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed) as {
      text?: string;
      result?: string;
      data?: { text?: string };
    };
    if (typeof parsed.text === 'string') return parsed.text.trim();
    if (typeof parsed.result === 'string') return parsed.result.trim();
    if (parsed.data && typeof parsed.data.text === 'string') return parsed.data.text.trim();
  } catch {
    // response_format=text 或兼容网关直接返回纯文本
  }
  return trimmed;
}

export async function transcribeAudio(
  wavBytes: Uint8Array,
  opts?: { reqId?: string; override?: Partial<SpeechAsrConfig> },
): Promise<{ text: string }> {
  if (!(wavBytes instanceof Uint8Array) || wavBytes.byteLength < 44) {
    throw new Error('音频数据为空或格式不完整。');
  }
  const cfg = loadConfig();
  const { endpointUrl, apiKey, model, language } = resolveEffectiveAsrConfig(cfg, opts?.override);
  const boundary = '----PetAsrBoundary' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const body = buildAsrMultipartBody(
    wavBytes,
    {
      model,
      response_format: 'json',
      ...(language ? { language } : {}),
    },
    boundary,
  );

  const reqId = opts?.reqId || `asr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const controller = new AbortController();
  activeAsrRequests.set(reqId, controller);

  return new Promise<{ text: string }>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      activeAsrRequests.delete(reqId);
      clearTimeout(timeoutHandle);
      controller.signal.removeEventListener('abort', onAbort);
      fn();
    };

    const request = net.request({
      method: 'POST',
      url: endpointUrl,
    });
    request.setHeader('Content-Type', `multipart/form-data; boundary=${boundary}`);
    request.setHeader('Accept', 'application/json');
    if (apiKey) {
      request.setHeader('Authorization', `Bearer ${apiKey}`);
    }

    const onAbort = () => {
      try {
        request.abort();
      } catch {
        // ignore
      }
      const abortErr = new Error('语音识别已取消');
      abortErr.name = 'AbortError';
      finish(() => reject(abortErr));
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });

    const timeoutHandle = setTimeout(() => {
      try {
        request.abort();
      } catch {
        // ignore
      }
      finish(() => reject(new Error('语音识别请求超时，请检查网络或接口地址。')));
    }, ASR_TIMEOUT_MS);

    request.on('response', (response) => {
      const statusCode = response.statusCode ?? 0;
      const decoder = new StringDecoder('utf8');
      let rawBody = '';
      response.on('data', (chunk: Buffer) => {
        rawBody += decoder.write(chunk);
      });
      response.on('end', () => {
        rawBody += decoder.end();
        finish(() => {
          try {
            const text = parseAsrResponse(statusCode, rawBody);
            resolve({ text });
          } catch (err) {
            reject(err);
          }
        });
      });
      response.on('error', (err: Error) => {
        finish(() => reject(new Error(`读取语音识别响应失败：${err.message}`)));
      });
    });

    request.on('error', (err: Error) => {
      finish(() => reject(new Error(`连接语音识别接口失败：${err.message}`)));
    });

    request.write(body);
    request.end();
  });
}

export async function testAsrConnection(
  override?: Partial<SpeechAsrConfig>,
): Promise<{ ok: true; latencyMs: number; text: string } | { ok: false; error: string }> {
  const started = Date.now();
  try {
    const silentWav = createSilentWav16(350, 16000);
    const res = await transcribeAudio(silentWav, { override });
    return {
      ok: true,
      latencyMs: Math.max(1, Date.now() - started),
      text: res.text,
    };
  } catch (err) {
    return {
      ok: false,
      error: (err as Error)?.message || String(err),
    };
  }
}
