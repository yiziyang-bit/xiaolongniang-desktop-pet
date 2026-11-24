/**
 * CompanionEngine：陪伴引擎编排层（主进程）。
 *
 * 每 2s 一个 tick：
 *   CodexSessionWatcher 事件 → buildWorldState → detectIntents → PolicyEngine.decide → 决策日志
 *
 * P0 阶段默认 recordOnly=true：只记录"如果放开会说哪句"，不弹气泡、不朗读；
 * 但会按真实策略更新每日计数/冷却（这样日志反映的就是放开后的真实发言轨迹）。
 * P1 打开 recordOnly=false 后通过 deps.onSay 推给渲染层。
 */
import { CodexSessionWatcher } from './session-watcher';
import { buildWorldState, classifyActivity } from './world-state';
import { detectIntents } from './intents';
import { decide } from './policy';
import { pickLine } from './lines';
import { CompanionStore, dateKey } from './store';
import { drainIdeFailures, IDE_FAILURE_INBOX } from './ide-failure-inbox';
import type {
  ActivityKind,
  CompanionIntent,
  CompanionStateFile,
  DecisionLogOptions,
  DecisionRecord,
  ForegroundInfo,
  WorldState,
} from './types';

const TICK_MS = 2000;
/** 同一 intent+reason 的抑制日志最少间隔（避免每 2s 刷一条） */
const SUPPRESS_LOG_INTERVAL_MS = 10 * 60 * 1000;
/** 心跳日志间隔（观察 watcher 是否在工作） */
const HEARTBEAT_LOG_INTERVAL_MS = 5 * 60 * 1000;
/** 状态落盘节流 */
const SAVE_INTERVAL_MS = 10 * 1000;

export interface CompanionSayPayload {
  intent: CompanionIntent;
  line: string;
  durationMs: number;
  voice: boolean;
  ts: number;
}

export interface CompanionEngineDeps {
  userDataDir: string;
  ideFailureInbox?: string;
  getIdleSeconds: () => number;
  getForeground: () => ForegroundInfo | null;
  isFullscreen: () => boolean;
  isWindowVisible: () => boolean;
  /** P1 才会被调用 */
  onSay?: (payload: CompanionSayPayload) => void;
}

export interface CompanionSummary {
  enabled: boolean;
  recordOnly: boolean;
  frequency: string;
  firstMetAt: string;
  today: {
    date: string;
    candidateCount: number;
    spokenCount: number;
    perIntent: Record<string, number>;
  };
  lastSpokeAt: number | null;
  watchedEvents: number;
  logDir: string;
}

export class CompanionEngine {
  private readonly deps: CompanionEngineDeps;
  private readonly store: CompanionStore;
  private readonly watcher: CodexSessionWatcher;
  private state: CompanionStateFile;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTickAt = 0;
  private lastSaveAt = 0;
  private lastHeartbeatAt = 0;
  private lastUserInteractionAt: number | null = null;
  private readonly suppressLoggedAt = new Map<string, number>();
  /** 不限次数模式中，同一个持续条件只触发一次；条件消失后重新允许。 */
  private readonly deliveredActiveIntents = new Set<CompanionIntent>();
  private readonly recentLines: string[] = [];
  private tickCount = 0;
  private lastWorld: WorldState | null = null;
  /** 当前活动分类 + 起始时间（用于「连续娱乐 90 分钟」这类判断） */
  private lastActivity: ActivityKind = 'other';
  private activitySince: number | null = null;

  constructor(deps: CompanionEngineDeps) {
    this.deps = deps;
    this.store = new CompanionStore(deps.userDataDir);
    this.watcher = new CodexSessionWatcher();
    this.state = this.store.loadState();
  }

  start(): void {
    if (this.timer) return;
    this.store.cleanupOldDecisions();
    this.watcher.start();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.watcher.stop();
    this.store.saveState(this.state);
  }

  getSummary(): CompanionSummary {
    return {
      enabled: this.state.prefs.enabled,
      recordOnly: this.state.prefs.recordOnly,
      frequency: this.state.prefs.frequency,
      firstMetAt: this.state.firstMetAt,
      today: {
        date: this.state.daily.date,
        candidateCount: this.state.daily.candidateCount,
        spokenCount: this.state.daily.spokenCount,
        perIntent: { ...this.state.daily.perIntent },
      },
      lastSpokeAt: this.state.lastSpokeAt,
      watchedEvents: this.watcher.recentEvents().length,
      logDir: this.store.directory,
    };
  }

  getDecisions(options: DecisionLogOptions = {}): DecisionRecord[] {
    return this.store.listDecisions(options);
  }

  clearDecisions(): number {
    return this.store.clearDecisions();
  }

  /** 用户摸头/点气泡/聊天时调用：60s 内不主动说话 */
  markUserInteraction(): void {
    this.lastUserInteractionAt = Date.now();
    this.state.interactionCount += 1;
    this.store.saveState(this.state);
  }

  /** 记录用户对某条陪伴气泡的点击/忽略（P1 用） */
  recordResponse(intent: CompanionIntent, action: 'clicked' | 'ignored'): void {
    if (action === 'ignored') {
      this.state.ignoredCount[intent] = (this.state.ignoredCount[intent] ?? 0) + 1;
    } else {
      this.state.ignoredCount[intent] = Math.max(0, (this.state.ignoredCount[intent] ?? 0) - 1);
      this.state.interactionCount += 1;
    }
    this.store.saveState(this.state);
  }

  // ---------------------------------------------------------------------------

  private tick(): void {
    try {
      const now = Date.now();
      this.lastTickAt = now;
      this.tickCount += 1;
      this.state = this.store.ensureDaily(this.state, now);
      if (this.state.prefs.enabled) {
        drainIdeFailures(this.deps.ideFailureInbox ?? IDE_FAILURE_INBOX, now, ({ time, ...ideFailure }) =>
          this.store.appendDecision({
            ts: localIso(time),
            intent: 'IDE_RUN_FAILED',
            world: null,
            decision: 'recorded',
            reason: 'ide_run_failed',
            line: null,
            voice: false,
            delivered: 'record_only',
            responded: null,
            ideFailure,
          }),
        );
      }

      const foreground = this.deps.getForeground();
      const idleSeconds = this.deps.getIdleSeconds();
      // 活动分类 + 同一活动计时（只按前台进程名分类，不读标题/网址）
      const activity = classifyActivity(foreground, idleSeconds);
      if (activity !== this.lastActivity || this.activitySince === null) {
        this.lastActivity = activity;
        this.activitySince = now;
      }
      const world = buildWorldState({
        now,
        events: this.watcher.recentEvents(),
        idleSeconds,
        foreground,
        fullscreen: this.deps.isFullscreen(),
        windowVisible: this.deps.isWindowVisible(),
        activity,
        activitySince: this.activitySince,
        lastSpokeAt: this.state.lastSpokeAt,
        lastUserInteractionAt: this.lastUserInteractionAt,
        lastSuccessHandledTs: this.state.lastSuccessHandledTs,
      });
      this.lastWorld = world;

      const candidates = detectIntents(world);
      if (this.state.prefs.frequency === 'unlimited') {
        const activeIntents = new Set(candidates.map((candidate) => candidate.intent));
        for (const intent of this.deliveredActiveIntents) {
          if (!activeIntents.has(intent)) this.deliveredActiveIntents.delete(intent);
        }
      } else {
        this.deliveredActiveIntents.clear();
      }
      this.maybeHeartbeat(world);
      if (candidates.length === 0) {
        this.saveThrottled(now);
        return;
      }

      for (const candidate of candidates) {
        if (this.state.prefs.frequency === 'unlimited' && this.deliveredActiveIntents.has(candidate.intent)) continue;
        // 每次成功只处理一遍，避免每 2s 重复触发
        if (candidate.intent === 'SUCCESS_AFTER_FAILS' && world.codex.lastSuccessAt !== null) {
          if (this.state.lastSuccessHandledTs === world.codex.lastSuccessAt) continue;
          if (this.state.prefs.frequency !== 'unlimited') this.state.lastSuccessHandledTs = world.codex.lastSuccessAt;
        }

        this.state.daily.candidateCount += 1;
        const result = decide(candidate, world, this.state.prefs, {
          daily: this.state.daily,
          lastSpokeAt: this.state.lastSpokeAt,
          ignoredCount: this.state.ignoredCount,
        });

        if (result.decision === 'suppress') {
          this.logDecision(candidate, world, result.decision, result.reason, null, false, 'record_only');
          break; // 本轮抑制，不再尝试其它候选
        }

        if (this.state.prefs.frequency === 'unlimited') {
          this.deliveredActiveIntents.add(candidate.intent);
          if (candidate.intent === 'SUCCESS_AFTER_FAILS' && world.codex.lastSuccessAt !== null) {
            this.state.lastSuccessHandledTs = world.codex.lastSuccessAt;
          }
        }

        const line = pickLine(candidate.intent, this.recentLines);
        this.recentLines.push(line);
        if (this.recentLines.length > 12) this.recentLines.shift();

        // recordOnly 也按真实策略计数：日志 = 放开后的真实发言轨迹
        this.state.daily.spokenCount += 1;
        this.state.daily.perIntent[candidate.intent] = (this.state.daily.perIntent[candidate.intent] ?? 0) + 1;
        this.state.lastSpokeAt = now;
        const delivered = this.state.prefs.recordOnly ? 'record_only' : 'bubble';
        this.logDecision(candidate, world, result.decision, result.reason, line, result.voice, delivered);

        if (!this.state.prefs.recordOnly) {
          try {
            this.deps.onSay?.({ intent: candidate.intent, line, durationMs: result.durationMs, voice: result.voice, ts: now });
          } catch {
            /* ignore renderer push errors */
          }
        }
        break; // 每 tick 最多一条
      }

      this.saveThrottled(now);
    } catch (error) {
      console.log('[companion] tick failed:', (error as Error).message);
    }
  }

  private logDecision(
    candidate: { intent: CompanionIntent; context: Record<string, unknown> },
    world: WorldState,
    decision: 'speak' | 'bubble_only' | 'suppress',
    reason: string,
    line: string | null,
    voice: boolean,
    delivered: 'record_only' | 'bubble' | 'voice',
  ): void {
    if (decision === 'suppress') {
      const key = `${candidate.intent}|${reason}`;
      const lastAt = this.suppressLoggedAt.get(key) ?? 0;
      if (world.now - lastAt < SUPPRESS_LOG_INTERVAL_MS) return;
      this.suppressLoggedAt.set(key, world.now);
    }
    const record: DecisionRecord = {
      ts: localIso(world.now),
      intent: candidate.intent,
      world: {
        hour: world.hour,
        idleSec: world.idleSeconds,
        foreground: world.foreground?.name ?? null,
        fullscreen: world.fullscreen,
        activity: world.activity,
        activityMinutes: world.activityMinutes,
        consecutiveErrors: world.codex.consecutiveErrors,
        workingMinutes: world.codex.workingMinutes,
        cwdHash: (candidate.context.cwdHash as string | null) ?? null,
      },
      decision,
      reason,
      line,
      voice,
      delivered,
      responded: null,
    };
    this.store.appendDecision(record);
    if (decision !== 'suppress') {
      console.log('[companion] decision:', record.intent, decision, reason, line ? `"${line}"` : '');
    }
  }

  private maybeHeartbeat(world: WorldState): void {
    if (world.now - this.lastHeartbeatAt < HEARTBEAT_LOG_INTERVAL_MS) return;
    this.lastHeartbeatAt = world.now;
    console.log(
      '[companion] heartbeat:',
      JSON.stringify({
        events: this.watcher.recentEvents().length,
        active: world.codex.sessionActive,
        errs: world.codex.consecutiveErrors,
        fg: world.foreground?.name ?? null,
        activity: world.activity,
        activityMinutes: world.activityMinutes,
        fullscreen: world.fullscreen,
        idleSec: world.idleSeconds,
        hour: world.hour,
        candidatesToday: this.state.daily.candidateCount,
        spokenToday: this.state.daily.spokenCount,
      }),
    );
  }

  private saveThrottled(now: number): void {
    if (now - this.lastSaveAt < SAVE_INTERVAL_MS) return;
    this.lastSaveAt = now;
    this.store.saveState(this.state);
  }
}

function localIso(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const offsetH = pad(Math.floor(Math.abs(offsetMin) / 60));
  const offsetM = pad(Math.abs(offsetMin) % 60);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${offsetH}:${offsetM}`;
}

export { dateKey };
