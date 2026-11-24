import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DECISION_RETENTION_DAYS, dateKey } from './store';
import type { IdeFailure } from './types';

export const IDE_FAILURE_INBOX = path.join(os.homedir(), '.desktop-pet-ide-events');

const EVENT_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const MAX_EVENT_BYTES = 1024;
const MAX_EVENTS_PER_TICK = 64;
const CLOCK_SKEW_MS = 60_000;

type FailureEvent = IdeFailure & { time: number };

function readFailure(file: string, id: string, now: number): FailureEvent | null {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > MAX_EVENT_BYTES) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> | null;
  if (!raw || raw.version !== 1 || raw.id !== id) return null;
  const { source, kind, exitCode, timestamp } = raw;
  if (source !== 'vscode' && source !== 'pycharm') return null;
  if (kind !== 'run' && (source !== 'vscode' || (kind !== 'terminal' && kind !== 'task'))) return null;
  if (typeof exitCode !== 'number' || !Number.isSafeInteger(exitCode) || exitCode === 0) return null;
  if (typeof timestamp !== 'string' || !ISO_UTC.test(timestamp)) return null;
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time) || time > now + CLOCK_SKEW_MS) return null;
  return { id, source, kind, exitCode, time };
}

/** Extensions publish complete files atomically. Keep valid events until they are saved. */
export function drainIdeFailures(dir: string, now: number, save: (event: FailureEvent) => boolean): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const oldestDay = dateKey(now - (DECISION_RETENTION_DAYS - 1) * 86_400_000);
  let handled = 0;
  for (const name of names) {
    const id = EVENT_FILE.exec(name)?.[1];
    if (!id) continue;
    const file = path.join(dir, name);
    try {
      const event = readFailure(file, id, now);
      if (!event) continue;
      handled += 1;
      if (dateKey(event.time) < oldestDay || save(event)) fs.unlinkSync(file);
    } catch {
      /* A failed save or removal is retried on the next tick. */
    }
    if (handled >= MAX_EVENTS_PER_TICK) break;
  }
}
