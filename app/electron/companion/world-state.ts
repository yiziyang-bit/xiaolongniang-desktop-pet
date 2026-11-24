/**
 * WorldState 组装：把 Codex 事件流 + 系统状态（空闲/前台/全屏）合成一个快照。
 * 纯函数，方便单测。
 */
import type { ActivityKind, CodexEvent, CodexSnapshot, ForegroundInfo, WorldState } from './types';
import { DEV_APP_KEYWORDS, LEISURE_APP_KEYWORDS } from './intents';

export interface WorldStateInput {
  now: number;
  events: CodexEvent[];
  idleSeconds: number;
  foreground: ForegroundInfo | null;
  fullscreen: boolean;
  windowVisible: boolean;
  /** 当前活动分类（engine 用 classifyActivity 维护并对同一活动计时）；缺省按 other */
  activity?: ActivityKind;
  /** 当前活动起始时间；null 表示未知 */
  activitySince?: number | null;
  lastSpokeAt: number | null;
  lastUserInteractionAt: number | null;
  lastSuccessHandledTs: number | null;
}

const SESSION_ACTIVE_MS = 5 * 60 * 1000;
const WORKING_WINDOW_MS = 4 * 60 * 60 * 1000;
/** 空闲超过这个时长且前台不是娱乐应用，视为「人离开了」 */
export const IDLE_LEFT_SECONDS = 30 * 60;

/**
 * 活动分类：只看前台进程名（不读标题/网址），把当前状态分成
 * work（IDE/终端/Codex、leisure（浏览器/视频/游戏）、idle（离开）、other。
 * 只用于判断时机，不记录具体内容。
 */
export function classifyActivity(foreground: ForegroundInfo | null, idleSeconds: number): ActivityKind {
  const name = (foreground?.name || '').toLowerCase();
  if (!name) return idleSeconds >= IDLE_LEFT_SECONDS ? 'idle' : 'other';
  if (LEISURE_APP_KEYWORDS.some((keyword) => name.includes(keyword))) return 'leisure';
  if (DEV_APP_KEYWORDS.some((keyword) => name.includes(keyword))) return 'work';
  if (idleSeconds >= IDLE_LEFT_SECONDS) return 'idle';
  return 'other';
}

export function buildWorldState(input: WorldStateInput): WorldState {
  const codex = buildCodexSnapshot(input.events, input.now);
  const activity = input.activity ?? 'other';
  const activityMinutes =
    input.activitySince != null && Number.isFinite(input.activitySince)
      ? Math.max(0, Math.floor((input.now - input.activitySince) / 60_000))
      : 0;
  return {
    now: input.now,
    hour: new Date(input.now).getHours(),
    idleSeconds: Math.max(0, Math.floor(input.idleSeconds)),
    foreground: input.foreground,
    fullscreen: input.fullscreen,
    windowVisible: input.windowVisible,
    activity,
    activityMinutes,
    codex,
    lastSpokeAt: input.lastSpokeAt,
    lastUserInteractionAt: input.lastUserInteractionAt,
    lastSuccessHandledTs: input.lastSuccessHandledTs,
  };
}

export function buildCodexSnapshot(events: CodexEvent[], now: number): CodexSnapshot {
  // 只取有成败结论的事件算"连续失败"
  const results = events.filter((e) => (e.kind === 'CMD_RESULT' || e.kind === 'MCP_RESULT') && typeof e.ok === 'boolean');

  let consecutiveErrors = 0;
  for (let i = results.length - 1; i >= 0; i--) {
    if (results[i].ok === false) consecutiveErrors += 1;
    else break;
  }

  let lastErrorAt: number | null = null;
  for (const event of results) {
    if (event.ok === false) lastErrorAt = event.ts;
  }

  let lastSuccessAt: number | null = null;
  let errorsBeforeLastSuccess = 0;
  for (let i = results.length - 1; i >= 0; i--) {
    const event = results[i];
    if (event.ok === true) {
      lastSuccessAt = event.ts;
      let streak = 0;
      for (let j = i - 1; j >= 0; j--) {
        if (results[j].ok === false) streak += 1;
        else break;
      }
      errorsBeforeLastSuccess = streak;
      break;
    }
  }

  let lastEventAt: number | null = null;
  let lastUserInputAt: number | null = null;
  let lastTurnStartedAt: number | null = null;
  for (const event of events) {
    if (lastEventAt === null || event.ts > lastEventAt) lastEventAt = event.ts;
    if (event.kind === 'USER_INPUT' && (lastUserInputAt === null || event.ts > lastUserInputAt)) lastUserInputAt = event.ts;
    if (event.kind === 'TURN_STARTED' && (lastTurnStartedAt === null || event.ts > lastTurnStartedAt)) lastTurnStartedAt = event.ts;
  }

  const sessionActive = lastEventAt !== null && now - lastEventAt <= SESSION_ACTIVE_MS;
  let workingMinutes = 0;
  if (lastTurnStartedAt !== null && now - lastTurnStartedAt <= WORKING_WINDOW_MS) {
    workingMinutes = Math.max(0, Math.floor((now - lastTurnStartedAt) / 60_000));
  }

  return {
    sessionActive,
    workingMinutes,
    consecutiveErrors,
    errorsBeforeLastSuccess,
    lastErrorAt,
    lastSuccessAt,
    lastEventAt,
    lastUserInputAt,
  };
}
