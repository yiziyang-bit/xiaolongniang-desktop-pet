/**
 * 发言策略（纯函数）。
 * 规则链按顺序短路，返回 speak / bubble_only / suppress + 原因（决策日志用）。
 */
import type { CompanionIntent, DailyStats, Frequency, IntentCandidate, PolicyResult, WorldState } from './types';

export const FREQUENCY_CAP: Record<Exclude<Frequency, 'unlimited'>, number> = {
  quiet: 3,
  normal: 8,
  lively: 15,
};

/** 单个 intent 的每日上限（P0.5：覆盖工作 + 娱乐） */
export const INTENT_DAILY_CAP: Partial<Record<CompanionIntent, number>> = {
  SUCCESS_AFTER_FAILS: 1,
  LATE_NIGHT_WORKING: 1,
  LATE_NIGHT_LEISURE: 1,
  LEISURE_LONG: 2,
  IDLE_LONG: 3,
};

/** 全局发言冷却 */
export const COOLDOWN_MS = 20 * 60 * 1000;
/** 用户刚互动过多久内不主动说话 */
export const RECENT_USER_ACTION_MS = 60 * 1000;
/** 气泡默认停留时长 */
const BUBBLE_DURATION_MS = 8000;

export interface PolicyStats {
  daily: DailyStats;
  lastSpokeAt: number | null;
  ignoredCount: Record<string, number>;
}

export interface PolicyPrefs {
  enabled: boolean;
  frequency: Frequency;
  quietStartHour: number;
  quietStartMinute: number;
  quietEndHour: number;
  quietEndMinute: number;
}

export function inQuietHours(now: number, prefs: PolicyPrefs): boolean {
  const date = new Date(now);
  const minutes = date.getHours() * 60 + date.getMinutes();
  const start = prefs.quietStartHour * 60 + prefs.quietStartMinute;
  const end = prefs.quietEndHour * 60 + prefs.quietEndMinute;
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end; // 跨午夜
}

export function decide(
  candidate: IntentCandidate,
  state: WorldState,
  prefs: PolicyPrefs,
  stats: PolicyStats,
): PolicyResult {
  // 1) 总开关
  if (!prefs.enabled) return suppress('disabled');
  // 2) 全屏应用（S4）
  if (state.fullscreen) return suppress('fullscreen');
  // 3) 用户刚互动过，不抢话
  if (state.lastUserInteractionAt !== null && state.now - state.lastUserInteractionAt < RECENT_USER_ACTION_MS) {
    return suppress('recent_user_action');
  }
  // 4) 窗口不可见
  if (!state.windowVisible) return suppress('window_hidden');
  // 不限次数模式不受每日总数、冷却和单意图每日上限约束。
  if (prefs.frequency !== 'unlimited') {
    const cap = FREQUENCY_CAP[prefs.frequency] ?? FREQUENCY_CAP.quiet;
    if (stats.daily.spokenCount >= cap) return suppress('daily_cap');
    if (stats.lastSpokeAt !== null && state.now - stats.lastSpokeAt < COOLDOWN_MS) {
      return suppress('cooldown');
    }
    const ignored = stats.ignoredCount[candidate.intent] ?? 0;
    const rawCap = INTENT_DAILY_CAP[candidate.intent];
    if (rawCap !== undefined) {
      const intentCap = ignored >= 3 ? Math.max(1, Math.ceil(rawCap / 2)) : rawCap;
      const used = stats.daily.perIntent[candidate.intent] ?? 0;
      if (used >= intentCap) return suppress('intent_daily_cap');
    }
  }
  // 8) 静音时段：可以说，但不出声
  if (inQuietHours(state.now, prefs)) {
    return { decision: 'bubble_only', reason: 'quiet_hours', voice: false, durationMs: BUBBLE_DURATION_MS };
  }
  return { decision: 'speak', reason: 'ok', voice: true, durationMs: BUBBLE_DURATION_MS };
}

function suppress(reason: string): PolicyResult {
  return { decision: 'suppress', reason, voice: false, durationMs: 0 };
}
