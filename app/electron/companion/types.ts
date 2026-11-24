/**
 * 陪伴引擎（B 类）共享类型
 *
 * P0 阶段只做「观察 + 判定 + 决策日志」，不弹气泡（recordOnly）。
 * 事件映射对应 Codex 本地会话的 JSONL 格式。
 */

export type CodexEventKind =
  | 'USER_INPUT'
  | 'TOOL_CALL'
  | 'CMD_RESULT'
  | 'FILE_CHANGE'
  | 'MCP_RESULT'
  | 'TURN_STARTED'
  | 'TURN_COMPLETED'
  | 'TURN_ABORTED';

export interface CodexEvent {
  /** epoch ms */
  ts: number;
  kind: CodexEventKind;
  /** CMD_RESULT / MCP_RESULT / FILE_CHANGE 的成败 */
  ok?: boolean;
  exitCode?: number;
  /** sha1(cwd).slice(0, 8)，不保存 cwd 原文 */
  cwdHash?: string;
  /** 工具名（最多 32 字符） */
  tool?: string;
  sessionId: string;
  durationMs?: number;
}

export interface ForegroundInfo {
  name: string;
  pid: number;
  bounds: { x: number; y: number; width: number; height: number };
}

export type CompanionIntent =
  | 'SUCCESS_AFTER_FAILS'
  | 'LATE_NIGHT_WORKING'
  | 'LATE_NIGHT_LEISURE'
  | 'LEISURE_LONG'
  | 'IDLE_LONG'
  // P1 预留
  | 'BREAK_OFFER'
  | 'GIVE_UP_CANDIDATE'
  | 'RETURN_AFTER_AWAY';

/** 当前活动分类（只分类，不含具体内容） */
export type ActivityKind = 'work' | 'leisure' | 'idle' | 'other';

export interface IntentCandidate {
  intent: CompanionIntent;
  priority: number;
  context: Record<string, string | number | boolean | null>;
}

export interface CodexSnapshot {
  sessionActive: boolean;
  workingMinutes: number;
  /** 当前末尾连续失败数（命令/MCP 结果） */
  consecutiveErrors: number;
  /** 最近一次成功之前连续失败了几次（SUCCESS_AFTER_FAILS 用） */
  errorsBeforeLastSuccess: number;
  lastErrorAt: number | null;
  lastSuccessAt: number | null;
  lastEventAt: number | null;
  lastUserInputAt: number | null;
}

export interface WorldState {
  now: number;
  hour: number;
  idleSeconds: number;
  foreground: ForegroundInfo | null;
  fullscreen: boolean;
  windowVisible: boolean;
  /** 当前活动分类 + 该活动已持续多少分钟（由 engine 维护起始时间） */
  activity: ActivityKind;
  activityMinutes: number;
  codex: CodexSnapshot;
  lastSpokeAt: number | null;
  lastUserInteractionAt: number | null;
  /** 已处理过的最近成功事件时间戳（防止同一成功被反复触发） */
  lastSuccessHandledTs: number | null;
}

export type Frequency = 'quiet' | 'normal' | 'lively' | 'unlimited';

export interface CompanionPrefs {
  enabled: boolean;
  /** P0 固定 true：只记录决策，不弹气泡、不朗读 */
  recordOnly: boolean;
  frequency: Frequency;
  /** 免打扰时段（默认 23:30–07:00：只出气泡、不出声） */
  quietStartHour: number;
  quietStartMinute: number;
  quietEndHour: number;
  quietEndMinute: number;
}

export type PolicyDecision = 'speak' | 'bubble_only' | 'suppress';

export interface PolicyResult {
  decision: PolicyDecision;
  reason: string;
  voice: boolean;
  durationMs: number;
}

export interface DailyStats {
  date: string;
  /** 真正说出去的条数（recordOnly 模式下不计） */
  spokenCount: number;
  /** 出现候选的次数（含被抑制的），用于观察判断频率 */
  candidateCount: number;
  perIntent: Record<string, number>;
}

export interface CompanionStateFile {
  version: 1;
  prefs: CompanionPrefs;
  /** 认识日期 YYYY-MM-DD */
  firstMetAt: string;
  daily: DailyStats;
  lastSpokeAt: number | null;
  lastSuccessHandledTs: number | null;
  interactionCount: number;
  ignoredCount: Record<string, number>;
}

export interface CompanionDecisionRecord {
  /** ISO 本地时间，带 +08:00 */
  ts: string;
  intent: CompanionIntent;
  world: {
    hour: number;
    idleSec: number;
    foreground: string | null;
    fullscreen: boolean;
    activity: ActivityKind;
    activityMinutes: number;
    consecutiveErrors: number;
    workingMinutes: number;
    cwdHash: string | null;
  };
  decision: PolicyDecision;
  reason: string;
  line: string | null;
  voice: boolean;
  delivered: 'record_only' | 'bubble' | 'voice';
  responded: 'clicked' | 'ignored' | null;
}

export interface IdeFailure {
  id: string;
  source: 'vscode' | 'pycharm';
  kind: 'terminal' | 'task' | 'run';
  exitCode: number;
}

export interface IdeFailureRecord {
  ts: string;
  intent: 'IDE_RUN_FAILED';
  world: null;
  decision: 'recorded';
  reason: 'ide_run_failed';
  line: null;
  voice: false;
  delivered: 'record_only';
  responded: null;
  ideFailure: IdeFailure;
}

export type DecisionRecord = CompanionDecisionRecord | IdeFailureRecord;
export type DecisionLogOptions = { limit?: number; decision?: DecisionRecord['decision']; days?: number };

export const DEFAULT_PREFS: CompanionPrefs = {
  enabled: true,
  recordOnly: true,
  frequency: 'quiet',
  quietStartHour: 23,
  quietStartMinute: 30,
  quietEndHour: 7,
  quietEndMinute: 0,
};
