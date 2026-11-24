import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

export interface LocalUsage { requests: number; inputTokens: number; outputTokens: number; lastRequestAt: number | null; note: string }
const empty = (): LocalUsage => ({ requests: 0, inputTokens: 0, outputTokens: 0, lastRequestAt: null, note: '本地估算值；兼容接口的流式响应未必返回 usage。' });
function file(): string { return path.join(app.getPath('userData'), 'usage-local.json'); }
function read(): LocalUsage { try { return { ...empty(), ...JSON.parse(fs.readFileSync(file(), 'utf8')) }; } catch { return empty(); } }
function write(v: LocalUsage): void { fs.mkdirSync(path.dirname(file()), { recursive: true }); fs.writeFileSync(file(), JSON.stringify(v, null, 2), 'utf8'); }
export function recordLocalUsage(inputTokens: number, outputTokens: number): void { const v = read(); v.requests++; v.inputTokens += Math.max(0, Math.round(inputTokens)); v.outputTokens += Math.max(0, Math.round(outputTokens)); v.lastRequestAt = Date.now(); write(v); }
export function getLocalUsage(): LocalUsage { return read(); }
export function clearLocalUsage(): void { write(empty()); }
