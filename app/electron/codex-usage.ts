import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export interface CodexQuotaWindow {
  id: string;
  label: string;
  minutes: number;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: number | null;
}

export interface CodexQuotaSnapshot {
  ok: boolean;
  queryOk: boolean;
  source: 'codex-app-server';
  observedAt: number | null;
  plan: string | null;
  planLabel: string;
  windows: CodexQuotaWindow[];
  stale: boolean;
  errorCode?: string;
  error?: string;
}

const EMPTY: CodexQuotaSnapshot = {
  ok: false,
  queryOk: false,
  source: 'codex-app-server',
  observedAt: null,
  plan: null,
  planLabel: '未读取',
  windows: [],
  stale: false,
};

let cached: CodexQuotaSnapshot | null = null;
let refreshPromise: Promise<CodexQuotaSnapshot> | null = null;
let cancelQuery: (() => void) | null = null;

function snapshotPath(): string {
  return path.join(app.getPath('userData'), 'codex-quota.json');
}

function loadSnapshot(): CodexQuotaSnapshot {
  if (cached) return cached;
  try {
    const value = JSON.parse(fs.readFileSync(snapshotPath(), 'utf8')) as CodexQuotaSnapshot;
    cached = { ...EMPTY, ...value, stale: true };
    return cached;
  } catch {
    cached = { ...EMPTY };
    return cached;
  }
}

function saveSnapshot(value: CodexQuotaSnapshot): void {
  try {
    fs.mkdirSync(path.dirname(snapshotPath()), { recursive: true });
    fs.writeFileSync(snapshotPath(), JSON.stringify(value, null, 2), 'utf8');
  } catch {
    // 额度读取不能影响桌宠主流程。
  }
}

function resolveCodexExecutable(): string | null {
  const executable = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const candidates: string[] = [];
  if (process.env.CODEX_EXECUTABLE) candidates.push(process.env.CODEX_EXECUTABLE);
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const root = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    candidates.push(path.join(root, executable));
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) candidates.push(path.join(root, entry.name, executable));
      }
    } catch { /* ignore */ }
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir.trim()) candidates.push(path.join(dir.trim().replace(/^"|"$/g, ''), executable));
  }
  for (const candidate of candidates) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* ignore */ }
  }
  return null;
}

function labelForMinutes(minutes: number): string {
  if (minutes % (60 * 24 * 30) === 0) return `${minutes / (60 * 24 * 30)} 个月`;
  if (minutes % (60 * 24) === 0) return `${minutes / (60 * 24)} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

function fingerprint(account: Record<string, unknown>): string | null {
  const values = ['id', 'accountId', 'chatgptAccountId', 'email']
    .map((key) => [key, typeof account[key] === 'string' ? String(account[key]).trim() : null] as const)
    .filter(([, value]) => value);
  if (!values.length) return null;
  return createHash('sha256').update(JSON.stringify([account.type, account.planType ?? null, values])).digest('hex');
}

function runQuery(): Promise<CodexQuotaSnapshot> {
  return new Promise((resolve) => {
    const executable = resolveCodexExecutable();
    if (!executable) { resolve({ ...loadSnapshot(), queryOk: false, errorCode: 'CODEX_NOT_FOUND', error: '未找到 Codex 程序' }); return; }
    let child: ReturnType<typeof spawn>;
    try { child = spawn(executable, ['app-server', '--stdio'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch { resolve({ ...loadSnapshot(), queryOk: false, errorCode: 'CODEX_START_FAILED', error: '无法启动 Codex App Server' }); return; }
    let buffer = '';
    let step = 1;
    let account: Record<string, unknown> = {};
    let finished = false;
    const timer = setTimeout(() => finish({ ...loadSnapshot(), queryOk: false, errorCode: 'CODEX_TIMEOUT', error: 'Codex 额度查询超时' }), 18_000);
    const finish = (value: CodexQuotaSnapshot) => {
      if (finished) return;
      finished = true;
      cancelQuery = null;
      clearTimeout(timer);
      try { child.stdin?.end(); child.kill(); } catch { /* ignore */ }
      resolve(value);
    };
    cancelQuery = () => finish({ ...EMPTY });
    const send = (value: Record<string, unknown>) => { try { child.stdin?.write(JSON.stringify(value) + '\n'); } catch { finish({ ...loadSnapshot(), queryOk: false, errorCode: 'CODEX_PIPE_FAILED', error: 'Codex 额度连接已结束' }); } };
    const handle = (message: Record<string, any>) => {
      if (finished || message.id !== step) return;
      if (message.error) { finish({ ...loadSnapshot(), queryOk: false, errorCode: 'CODEX_RPC_ERROR', error: 'Codex 额度接口返回错误' }); return; }
      if (step === 1) {
        send({ method: 'initialized', params: {} });
        step = 2;
        send({ id: 2, method: 'account/read', params: { refreshToken: false } });
      } else if (step === 2) {
        account = (message.result?.account ?? {}) as Record<string, unknown>;
        step = 3;
        send({ id: 3, method: 'account/rateLimits/read', params: {} });
      } else {
        const result = message.result ?? {};
        const buckets = result.rateLimitsByLimitId && typeof result.rateLimitsByLimitId === 'object'
          ? Object.entries(result.rateLimitsByLimitId as Record<string, any>)
          : [['codex', result.rateLimits]] as Array<[string, any]>;
        const windows: CodexQuotaWindow[] = [];
        for (const [bucketId, bucket] of buckets) {
          for (const key of ['primary', 'secondary']) {
            const raw = bucket?.[key];
            if (!raw || !Number.isSafeInteger(raw.windowDurationMins) || typeof raw.usedPercent !== 'number') continue;
            if (raw.usedPercent < 0 || raw.usedPercent > 100) continue;
            const duplicate = windows.some((w) => w.minutes === raw.windowDurationMins);
            if (duplicate) continue;
            windows.push({
              id: `${bucketId}:${key}`,
              label: labelForMinutes(raw.windowDurationMins),
              minutes: raw.windowDurationMins,
              usedPercent: raw.usedPercent,
              remainingPercent: Math.max(0, 100 - raw.usedPercent),
              resetsAt: typeof raw.resetsAt === 'number' ? raw.resetsAt : null,
            });
          }
        }
        windows.sort((a, b) => a.minutes - b.minutes);
        const now = Date.now();
        const value: CodexQuotaSnapshot = {
          ok: windows.length > 0,
          queryOk: true,
          source: 'codex-app-server',
          observedAt: now,
          plan: typeof account.planType === 'string' ? account.planType : null,
          planLabel: typeof account.planType === 'string' ? account.planType : 'ChatGPT 额度',
          windows,
          stale: false,
          ...(windows.length ? {} : { errorCode: 'NO_WINDOWS', error: '当前账号没有返回可显示的额度窗口' }),
        };
        const previous = loadSnapshot();
        const currentFingerprint = fingerprint(account);
        const previousFingerprint = (previous as CodexQuotaSnapshot & { accountFingerprint?: string }).accountFingerprint;
        if (currentFingerprint && previousFingerprint && currentFingerprint !== previousFingerprint) {
          // 账号切换时只保留新查询结果，避免把旧账号额度显示给用户。
          value.windows = windows;
        }
        (value as CodexQuotaSnapshot & { accountFingerprint?: string }).accountFingerprint = currentFingerprint ?? undefined;
        cached = value;
        saveSnapshot(value);
        finish(value);
      }
    };
    const stdoutDecoder = new StringDecoder('utf8');
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += stdoutDecoder.write(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) { if (!line || line.length > 2 * 1024 * 1024) continue; try { handle(JSON.parse(line)); } catch { /* ignore non JSON */ } }
    });
    child.once('error', () => { if (!finished) finish({ ...loadSnapshot(), queryOk: false, errorCode: 'CODEX_PROCESS_ERROR', error: 'Codex 额度进程错误' }); });
    child.once('close', () => {
      buffer += stdoutDecoder.end();
      if (!finished && buffer.trim() && buffer.length <= 2 * 1024 * 1024) {
        try { handle(JSON.parse(buffer.trim())); } catch { /* ignore non JSON */ }
      }
      if (!finished && step < 3) finish({ ...loadSnapshot(), queryOk: false, errorCode: 'CODEX_CLOSED', error: 'Codex 额度服务已结束' });
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'desktop-pet', title: 'Desktop Pet', version: app.getVersion() } } });
  });
}

export function getCodexQuota(): CodexQuotaSnapshot { return loadSnapshot(); }
export function cancelCodexQuotaRefresh(): void { cancelQuery?.(); }
export function refreshCodexQuota(): Promise<CodexQuotaSnapshot> {
  if (!refreshPromise) refreshPromise = runQuery().finally(() => { refreshPromise = null; });
  return refreshPromise;
}
