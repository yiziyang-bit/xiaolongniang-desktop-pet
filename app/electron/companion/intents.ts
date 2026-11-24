/**
 * Intent 判定（纯函数）。
 * P0 只启用 3 个：SUCCESS_AFTER_FAILS / LATE_NIGHT_WORKING / IDLE_LONG。
 * P1 再补 BREAK_OFFER / GIVE_UP_CANDIDATE / RETURN_AFTER_AWAY / LATE_NIGHT_LEISURE。
 */
import type { CompanionIntent, IntentCandidate, WorldState } from './types';

/** 前台进程名（小写）里视为「在写代码/终端」的关键词 */
export const DEV_APP_KEYWORDS = [
  'code',
  'cursor',
  'windsurf',
  'devenv',
  'idea64',
  'pycharm',
  'webstorm64',
  'goland64',
  'rider',
  'windowsterminal',
  'terminal',
  'wt',
  'powershell',
  'pwsh',
  'cmd',
  'conhost',
  'mintty',
  'alacritty',
  'wezterm',
  'codex',
];

/** 前台进程名里视为「娱乐」的关键词：浏览器 / 视频播放器 / 游戏平台。
 *  只用于活动分类，不读窗口标题或网址，所以无法区分「浏览器里工作还是娱乐」——统一按娱乐处理。 */
export const LEISURE_APP_KEYWORDS = [
  // 浏览器
  'chrome',
  'msedge',
  'firefox',
  'brave',
  'opera',
  'vivaldi',
  // 视频播放器
  'potplayer',
  'vlc',
  'mpc-hc',
  'mpc-hc64',
  'mpv',
  'bilibili',
  'iqiyi',
  'youku',
  'qqlive',
  'tencentvideo',
  'qqplayer',
  // 游戏平台 / 常见游戏
  'steam',
  'steamwebhelper',
  'epicgameslauncher',
  'battle.net',
  'wegame',
  'leagueclient',
  'valorant',
  'cs2',
  'csgo',
  'overwatch',
  'genshinimpact',
  'yuanshen',
  'starrail',
  'minecraft',
];

export const INTENT_PRIORITY: Record<CompanionIntent, number> = {
  SUCCESS_AFTER_FAILS: 100,
  GIVE_UP_CANDIDATE: 80,
  BREAK_OFFER: 70,
  LATE_NIGHT_WORKING: 60,
  LEISURE_LONG: 55,
  LATE_NIGHT_LEISURE: 50,
  RETURN_AFTER_AWAY: 45,
  IDLE_LONG: 40,
};

/** SUCCESS_AFTER_FAILS 允许的"成功后触发窗口" */
const SUCCESS_TRIGGER_WINDOW_MS = 5000;
/** SUCCESS_AFTER_FAILS 要求成功前连续失败数 */
const MIN_ERRORS_BEFORE_SUCCESS = 2;
/** 深夜工作：最近多久有 Codex 事件算"在工作" */
const WORKING_RECENT_MS = 5 * 60 * 1000;
/** 编辑器在前台时，最近有输入才视为正在工作。 */
const EDITOR_ACTIVE_IDLE_SECONDS = 5 * 60;
/** 长时间无操作 */
const IDLE_LONG_SECONDS = 30 * 60;
/** 人离开但前台还停在浏览器/视频（如看视频睡着）时，空闲超过这个时长也算离开 */
const IDLE_LEFT_ANY_ACTIVITY_SECONDS = 2 * 60 * 60;
/** 连续娱乐多久提醒休息 */
const LEISURE_LONG_MINUTES = 90;

export function detectIntents(state: WorldState): IntentCandidate[] {
  const candidates: IntentCandidate[] = [];
  const codex = state.codex;

  // 1) 连错后跑通
  if (
    codex.lastSuccessAt !== null &&
    state.now - codex.lastSuccessAt <= SUCCESS_TRIGGER_WINDOW_MS &&
    codex.errorsBeforeLastSuccess >= MIN_ERRORS_BEFORE_SUCCESS &&
    state.lastSuccessHandledTs !== codex.lastSuccessAt
  ) {
    candidates.push({
      intent: 'SUCCESS_AFTER_FAILS',
      priority: INTENT_PRIORITY.SUCCESS_AFTER_FAILS,
      context: { errorsBefore: codex.errorsBeforeLastSuccess, cwdHash: null },
    });
  }

  // 2) 深夜还在写代码
  const foregroundName = (state.foreground?.name || '').toLowerCase();
  const isDevApp = DEV_APP_KEYWORDS.some((keyword) => foregroundName.includes(keyword));
  const isSupportedEditor = /^(?:code(?: - insiders)?|pycharm(?:64)?)(?:\.exe)?$/.test(foregroundName);
  const recentCodexActivity = codex.lastEventAt !== null && state.now - codex.lastEventAt <= WORKING_RECENT_MS;
  const activeEditor = isSupportedEditor && state.idleSeconds < EDITOR_ACTIVE_IDLE_SECONDS;
  if (
    (state.hour === 23 || (state.hour >= 0 && state.hour < 5)) &&
    ((isDevApp && recentCodexActivity) || activeEditor)
  ) {
    candidates.push({
      intent: 'LATE_NIGHT_WORKING',
      priority: INTENT_PRIORITY.LATE_NIGHT_WORKING,
      context: { foreground: foregroundName, workingMinutes: recentCodexActivity ? codex.workingMinutes : null },
    });
  }

  // 3) 深夜还在娱乐（刷视频 / 游戏）
  if ((state.hour === 23 || (state.hour >= 0 && state.hour < 5)) && state.activity === 'leisure') {
    candidates.push({
      intent: 'LATE_NIGHT_LEISURE',
      priority: INTENT_PRIORITY.LATE_NIGHT_LEISURE,
      context: { foreground: foregroundName, activityMinutes: state.activityMinutes },
    });
  }

  // 4) 连续娱乐太久（浏览器 / 视频 / 游戏）
  if (state.activity === 'leisure' && state.activityMinutes >= LEISURE_LONG_MINUTES) {
    candidates.push({
      intent: 'LEISURE_LONG',
      priority: INTENT_PRIORITY.LEISURE_LONG,
      context: { activityMinutes: state.activityMinutes, foreground: foregroundName },
    });
  }

  // 5) 长时间无操作（人真离开；看视频/打游戏时不算——避免「忙完了记得回来」误报）
  if (
    state.idleSeconds >= IDLE_LONG_SECONDS &&
    state.windowVisible &&
    (state.activity !== 'leisure' || state.idleSeconds >= IDLE_LEFT_ANY_ACTIVITY_SECONDS)
  ) {
    candidates.push({
      intent: 'IDLE_LONG',
      priority: INTENT_PRIORITY.IDLE_LONG,
      context: { idleMinutes: Math.floor(state.idleSeconds / 60), activity: state.activity },
    });
  }

  return candidates.sort((a, b) => b.priority - a.priority);
}
