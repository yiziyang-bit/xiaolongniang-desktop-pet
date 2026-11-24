/**
 * 台词模板池。P0 只写进决策日志（recordOnly 不展示），P1 才真正弹气泡。
 * 人设约束：第一人称、≤20 字、不说教、不追问、不连续两句话。
 */
import type { CompanionIntent } from './types';

export const LINES: Record<CompanionIntent, string[]> = {
  SUCCESS_AFTER_FAILS: ['跑通啦，我看到了', '我们真棒', '终于过了，厉害呀', '这次明明就对了嘛'],
  LATE_NIGHT_WORKING: ['你累不累，我们一起休息好不好', '夜深了，早点睡吧', '再写一会儿就睡，好不好'],
  LATE_NIGHT_LEISURE: ['明天再看嘛', '该睡啦，明天还长着呢', '夜里的时光过得很快哦'],
  LEISURE_LONG: ['看了好久啦，起来动一动嘛', '要不要喝口水，休息一下眼睛', '陪我玩一会儿再继续看？'],
  IDLE_LONG: ['要不要回来看看我呀', '我在这里等你哦', '忙完了记得回来'],
  BREAK_OFFER: ['写了这么久，喝口水吧', '起来动一动嘛', '眼睛也要休息一下'],
  GIVE_UP_CANDIDATE: ['别放弃呀，你还有我在呢', '再试一次好不好', '卡住了就先歇一会儿'],
  RETURN_AFTER_AWAY: ['回来啦，我一直在', '刚刚去哪了呀'],
};

export const FALLBACK_LINE = '我在这儿陪着你';

/** 从模板池里抽一句，尽量避开最近说过的 */
export function pickLine(intent: CompanionIntent, recentlySpoken: string[] = []): string {
  const pool = LINES[intent];
  if (!pool || pool.length === 0) return FALLBACK_LINE;
  const fresh = pool.filter((line) => !recentlySpoken.includes(line));
  const candidates = fresh.length > 0 ? fresh : pool;
  return candidates[Math.floor(Math.random() * candidates.length)];
}
