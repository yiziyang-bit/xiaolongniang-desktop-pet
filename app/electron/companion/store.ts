/**
 * CompanionStore：陪伴引擎的本地持久化。
 *
 * - state.json：偏好、每日计数、冷却、认识日期、忽略计数
 * - decisions-YYYY-MM-DD.jsonl：决策日志（按天滚动，保留 14 天）
 *
 * 隐私：只存推断后的类别与 hash，不存窗口标题 / 命令行 / 输出 / cwd 原文。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { CompanionStateFile, DailyStats, DecisionLogOptions, DecisionRecord } from './types';
import { DEFAULT_PREFS } from './types';

export const DECISION_RETENTION_DAYS = 14;

export class CompanionStore {
  private readonly dir: string;
  private readonly statePath: string;

  constructor(userDataDir: string) {
    this.dir = path.join(userDataDir, 'companion');
    this.statePath = path.join(this.dir, 'state.json');
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch {
      /* ignore */
    }
  }

  get directory(): string {
    return this.dir;
  }

  loadState(now = Date.now()): CompanionStateFile {
    const fresh = emptyState(now);
    try {
      if (!fs.existsSync(this.statePath)) return fresh;
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as Partial<CompanionStateFile>;
      return {
        version: 1,
        prefs: { ...DEFAULT_PREFS, ...(raw.prefs ?? {}) },
        firstMetAt: typeof raw.firstMetAt === 'string' ? raw.firstMetAt : fresh.firstMetAt,
        daily: normalizeDaily(raw.daily, now),
        lastSpokeAt: typeof raw.lastSpokeAt === 'number' ? raw.lastSpokeAt : null,
        lastSuccessHandledTs: typeof raw.lastSuccessHandledTs === 'number' ? raw.lastSuccessHandledTs : null,
        interactionCount: typeof raw.interactionCount === 'number' ? raw.interactionCount : 0,
        ignoredCount: raw.ignoredCount && typeof raw.ignoredCount === 'object' ? raw.ignoredCount : {},
      };
    } catch {
      return fresh;
    }
  }

  /** 跨天时重置每日计数 */
  ensureDaily(state: CompanionStateFile, now: number): CompanionStateFile {
    const today = dateKey(now);
    if (state.daily.date !== today) {
      state.daily = { date: today, spokenCount: 0, candidateCount: 0, perIntent: {} };
    }
    return state;
  }

  saveState(state: CompanionStateFile): void {
    try {
      const tmp = `${this.statePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmp, this.statePath);
    } catch {
      /* 状态写失败不致命 */
    }
  }

  appendDecision(record: DecisionRecord): boolean {
    try {
      const day = record.ts.slice(0, 10);
      const file = path.join(this.dir, `decisions-${day}.jsonl`);
      if (record.decision === 'recorded' && fs.existsSync(file)) {
        // If the app stopped after saving but before clearing the inbox, acknowledge
        // the same event without appending it twice.
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
          if (!line.includes(record.ideFailure.id)) continue;
          try {
            const saved = JSON.parse(line) as DecisionRecord;
            if (saved?.decision === 'recorded' && saved.ideFailure?.id === record.ideFailure.id) return true;
          } catch {
            /* Skip damaged lines. */
          }
        }
      }
      fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  listDecisions(options: DecisionLogOptions = {}): DecisionRecord[] {
    const limit = Math.max(1, Math.min(200, options.limit ?? 30));
    const days = Math.max(1, Math.min(DECISION_RETENTION_DAYS, options.days ?? DECISION_RETENTION_DAYS));
    const out: DecisionRecord[] = [];
    const now = Date.now();
    for (let i = 0; i < days; i++) {
      const day = dateKey(now - i * 86_400_000);
      const file = path.join(this.dir, `decisions-${day}.jsonl`);
      if (!fs.existsSync(file)) continue;
      try {
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const record = JSON.parse(line) as DecisionRecord;
            if (typeof record?.ts !== 'string' || !Number.isFinite(Date.parse(record.ts))) continue;
            if (options.decision && record.decision !== options.decision) continue;
            out.push(record);
          } catch {
            /* 跳过坏行 */
          }
        }
      } catch {
        /* ignore */
      }
    }
    return out.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, limit);
  }

  clearDecisions(): number {
    let removed = 0;
    try {
      for (const name of fs.readdirSync(this.dir)) {
        if (name.startsWith('decisions-') && name.endsWith('.jsonl')) {
          fs.rmSync(path.join(this.dir, name), { force: true });
          removed += 1;
        }
      }
    } catch {
      /* ignore */
    }
    return removed;
  }

  cleanupOldDecisions(): void {
    try {
      const cutoff = Date.now() - DECISION_RETENTION_DAYS * 86_400_000;
      for (const name of fs.readdirSync(this.dir)) {
        const match = /^decisions-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
        if (!match) continue;
        const day = Date.parse(`${match[1]}T00:00:00`);
        if (Number.isFinite(day) && day < cutoff) fs.rmSync(path.join(this.dir, name), { force: true });
      }
    } catch {
      /* ignore */
    }
  }
}

export function dateKey(ms: number): string {
  const date = new Date(ms);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function emptyDaily(now: number): DailyStats {
  return { date: dateKey(now), spokenCount: 0, candidateCount: 0, perIntent: {} };
}

function emptyState(now: number): CompanionStateFile {
  return {
    version: 1,
    prefs: { ...DEFAULT_PREFS },
    firstMetAt: dateKey(now),
    daily: emptyDaily(now),
    lastSpokeAt: null,
    lastSuccessHandledTs: null,
    interactionCount: 0,
    ignoredCount: {},
  };
}

function normalizeDaily(raw: DailyStats | undefined, now: number): DailyStats {
  const fresh = emptyDaily(now);
  if (!raw || typeof raw !== 'object') return fresh;
  return {
    date: typeof raw.date === 'string' ? raw.date : fresh.date,
    spokenCount: typeof raw.spokenCount === 'number' ? raw.spokenCount : 0,
    candidateCount: typeof raw.candidateCount === 'number' ? raw.candidateCount : 0,
    perIntent: raw.perIntent && typeof raw.perIntent === 'object' ? raw.perIntent : {},
  };
}
