/**
 * CodexSessionWatcher：只读增量 tail ~/.codex/sessions 下的 rollout JSONL。
 *
 * 真实格式（2026-10-31 调研）：
 * - 路径 %USERPROFILE%\.codex\sessions\YYYY\MM\DD\rollout-*.jsonl
 * - 每行 JSON：{ type, timestamp(ISO UTC), ordinal, payload }
 * - 关键事件映射见 mapLine()
 *
 * 约束：
 * - 只读，不写 ~/.codex，不上传
 * - 增量读取（offset + 未完成行 buffer），单文件可达 50MB+
 * - 首次只回扫最近约 4MB，避免启动时读整份历史
 * - 内存只保留最近 200 条事件；解析失败的行跳过
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { CodexEvent } from './types';

const MAX_EVENTS = 200;
const POLL_MS = 2000;
const INITIAL_TAIL_BYTES = 4 * 1024 * 1024;
const MAX_READ_PER_TICK = 2 * 1024 * 1024;
const DAY_LOOKBACK = 3;
const DISCOVERY_INTERVAL_MS = 30_000;

interface FileCursor {
  offset: number;
  partial: string;
  sessionId: string;
  decoder: StringDecoder;
  dropFirstLine: boolean;
}

export interface SessionWatcherOptions {
  sessionsRoot?: string;
  pollMs?: number;
  now?: () => number;
}

export class CodexSessionWatcher {
  private readonly sessionsRoot: string;
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly knownFiles = new Set<string>();
  private readonly files = new Map<string, FileCursor>();
  private readonly events: CodexEvent[] = [];
  private readonly listeners = new Set<(event: CodexEvent) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastPollErrorAt = 0;
  private lastDiscoveryAt: number | null = null;

  constructor(options: SessionWatcherOptions = {}) {
    this.sessionsRoot = options.sessionsRoot ?? path.join(os.homedir(), '.codex', 'sessions');
    this.pollMs = options.pollMs ?? POLL_MS;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  onEvent(cb: (event: CodexEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  recentEvents(limit = MAX_EVENTS): CodexEvent[] {
    return limit >= this.events.length ? [...this.events] : this.events.slice(-limit);
  }

  get root(): string {
    return this.sessionsRoot;
  }

  // ---------------------------------------------------------------------------

  private async poll(): Promise<void> {
    try {
      const files = this.listCandidateFiles();
      for (const { file, sessionId } of files) {
        this.consumeFile(file, sessionId);
      }
    } catch (error) {
      const now = Date.now();
      if (now - this.lastPollErrorAt > 60_000) {
        this.lastPollErrorAt = now;
        console.log('[companion] session watcher poll failed:', (error as Error).message);
      }
    }
  }

  /** 会话保存在创建日期目录中；按修改时间选取最近活跃的文件。 */
  private listCandidateFiles(): Array<{ file: string; sessionId: string }> {
    if (!fs.existsSync(this.sessionsRoot)) return [];
    const now = this.now();
    if (this.lastDiscoveryAt === null || now - this.lastDiscoveryAt >= DISCOVERY_INTERVAL_MS) {
      this.indexDirectory(this.sessionsRoot, 0);
      this.lastDiscoveryAt = now;
    }
    // 新会话通常在这几个日期目录中，每轮发现，避免错过短暂的成功事件。
    const today = new Date(now);
    for (let d = 0; d < DAY_LOOKBACK; d++) {
      const day = new Date(today.getTime() - d * 86_400_000);
      const dir = path.join(
        this.sessionsRoot,
        String(day.getFullYear()),
        String(day.getMonth() + 1).padStart(2, '0'),
        String(day.getDate()).padStart(2, '0'),
      );
      this.indexDirectory(dir, 3);
    }
    const candidates: Array<{ file: string; sessionId: string; mtime: number }> = [];
    for (const file of this.knownFiles) {
      try {
        candidates.push({ file, sessionId: sessionIdOf(path.basename(file)), mtime: fs.statSync(file).mtimeMs });
      } catch {
        this.knownFiles.delete(file);
        this.files.delete(file);
      }
    }
    return candidates
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 12)
      .map(({ file, sessionId }) => ({ file, sessionId }));
  }

  /** 只枚举 YYYY/MM/DD 目录中的 rollout 文件，不读取历史正文。 */
  private indexDirectory(dir: string, depth: number): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (depth === 3 && entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        this.knownFiles.add(file);
      } else if (depth < 3 && entry.isDirectory() && (depth === 0 ? /^\d{4}$/ : /^\d{2}$/).test(entry.name)) {
        this.indexDirectory(file, depth + 1);
      }
    }
  }

  private consumeFile(file: string, sessionId: string): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return;
    }
    const cursor = this.files.get(file);
    if (!cursor || stat.size < cursor.offset) {
      // 首次读取（或文件截短）只回扫最近 4MB，逐块读完，不跳过最新尾部。
      const start = Math.max(0, stat.size - INITIAL_TAIL_BYTES);
      const nextCursor: FileCursor = {
        offset: start, partial: '', sessionId, decoder: new StringDecoder('utf8'), dropFirstLine: start > 0,
      };
      this.files.set(file, nextCursor);
      while (nextCursor.offset < stat.size) {
        const before = nextCursor.offset;
        this.readFrom(file, nextCursor, stat.size);
        if (nextCursor.offset === before) break;
      }
      return;
    }
    if (stat.size <= cursor.offset) return;
    this.readFrom(file, cursor, stat.size);
  }

  private readFrom(file: string, cursor: FileCursor, size: number): void {
    let fd: number | null = null;
    try {
      fd = fs.openSync(file, 'r');
      const offset = cursor.offset;
      const chunk = Buffer.alloc(Math.min(MAX_READ_PER_TICK, Math.max(0, size - offset)));
      if (chunk.length === 0) return;
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, offset);
      if (bytesRead === 0) return;
      cursor.offset = offset + bytesRead;
      let text = cursor.partial + cursor.decoder.write(chunk.subarray(0, bytesRead));
      if (cursor.dropFirstLine) {
        const firstNewline = text.indexOf('\n');
        if (firstNewline < 0) return;
        text = text.slice(firstNewline + 1);
        cursor.dropFirstLine = false;
      }
      const lines = text.split('\n');
      cursor.partial = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const events = mapLine(line, cursor.sessionId);
        for (const event of events) this.push(event);
      }
    } catch {
      // 单文件读取失败忽略，下轮再试
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
  }

  private push(event: CodexEvent): void {
    this.events.push(event);
    // 多个会话可能交错读取，始终保留时间最新的事件供连续成败判定。
    this.events.sort((a, b) => a.ts - b.ts);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    for (const cb of this.listeners) {
      try {
        cb(event);
      } catch {
        /* ignore listener errors */
      }
    }
  }
}

/** 文件名 rollout-2026-10-28T14-37-15-<uuid>[_<uuid>].jsonl → sessionId（按时间前缀归并） */
function sessionIdOf(filename: string): string {
  return filename.replace(/^rollout-/, '').replace(/\.jsonl$/, '').split('_')[0];
}

export function hashCwd(cwd: string): string {
  return createHash('sha1').update(cwd).digest('hex').slice(0, 8);
}

/**
 * 单行 JSON → 标准事件（可能 0 条）。
 * 只依赖实测稳定字段；未知结构一律忽略。
 */
export function mapLine(line: string, sessionId: string): CodexEvent[] {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return [];
  }
  if (!obj || typeof obj !== 'object') return [];
  const record = obj as Record<string, unknown>;
  const ts = Date.parse(String(record.timestamp ?? '')) || Date.now();
  const type = String(record.type ?? '');
  const payload = (record.payload ?? {}) as Record<string, unknown>;
  const ptype = String(payload.type ?? '');

  if (type === 'response_item') {
    if (ptype === 'message' && payload.role === 'user') {
      return [{ ts, kind: 'USER_INPUT', sessionId }];
    }
    if (ptype === 'custom_tool_call' || ptype === 'function_call') {
      return [{ ts, kind: 'TOOL_CALL', tool: String(payload.name ?? '').slice(0, 32), sessionId }];
    }
    return [];
  }

  if (type === 'event_msg') {
    if (ptype === 'item_completed') {
      const item = payload.item as Record<string, unknown> | undefined;
      if (!item) return [];
      const cwdHash = typeof item.cwd === 'string' ? hashCwd(item.cwd) : undefined;
      const ok = item.status === 'completed';
      switch (String(item.type ?? '')) {
        case 'CommandExecution': {
          const exitCode = typeof item.exit_code === 'number' ? item.exit_code : undefined;
          return [
            {
              ts,
              kind: 'CMD_RESULT',
              ok: ok && (exitCode === undefined || exitCode === 0),
              exitCode,
              cwdHash,
              durationMs: typeof item.duration === 'number' ? item.duration : undefined,
              sessionId,
            },
          ];
        }
        case 'FileChange':
          return [{ ts, kind: 'FILE_CHANGE', ok, cwdHash, sessionId }];
        case 'McpToolCall':
          return [{ ts, kind: 'MCP_RESULT', ok, cwdHash, sessionId }];
        default:
          return [];
      }
    }
    if (ptype === 'task_started') return [{ ts, kind: 'TURN_STARTED', sessionId }];
    if (ptype === 'task_complete') return [{ ts, kind: 'TURN_COMPLETED', sessionId }];
    if (ptype === 'turn_aborted') return [{ ts, kind: 'TURN_ABORTED', sessionId }];
    return [];
  }

  return [];
}
