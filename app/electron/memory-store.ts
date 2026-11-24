/**
 * memory-store — 用户级长期记忆。
 *
 * 存储位置:`app.getPath('userData')/memory.json`
 *  - Windows: `C:\Users\<USERNAME>\AppData\Roaming\<appName>\memory.json`
 *  - macOS:   `~/Library/Application Support/<appName>/memory.json`
 *  - Linux:   `~/.config/<appName>/memory.json`
 *
 * 跨模型、跨会话:每次 streamChat 都会把这里的内容注入到 system prompt 里,
 * 这样 AI 在任何会话、用任何模型,都能"记得"用户告诉过它的事。
 *
 * AI 通过两个 builtin tool 操作记忆:
 *  - `app__remember`(content)            → 写入新条目
 *  - `app__forget`(id 或 content_match)  → 删除指定条目
 */

import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

// better-sqlite3 是可选的原生依赖：开发环境未安装/原生模块加载失败时，
// 自动回退到旧 memory.json，避免首次启动因 ABI 不匹配而崩溃。
const require = createRequire(import.meta.url);
let Sqlite: any = null;
try { Sqlite = require('better-sqlite3'); } catch { /* fallback */ }

export interface Memory {
  id: string;
  content: string;
  /** Unix ms */
  createdAt: number;
}

function memoryPath(): string {
  return path.join(app.getPath('userData'), 'memory.json');
}

function sqlitePath(): string { return path.join(app.getPath('userData'), 'memory.sqlite3'); }
function sqliteDb(): any | null {
  if (!Sqlite) return null;
  try {
    const db = new Sqlite(sqlitePath());
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, content TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL)');
    return db;
  } catch { return null; }
}

function genId(): string {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 8)
  );
}

function load(): Memory[] {
  const db = sqliteDb();
  if (db) {
    try {
      const rows = db.prepare('SELECT id, content, created_at AS createdAt FROM memories ORDER BY created_at ASC').all();
      db.close();
      if (rows.length) return rows as Memory[];
      // 一次性迁移旧 JSON，保留用户已有记忆。
      const legacy = loadJson();
      if (legacy.length) { const insert = dbOpenInsert(legacy); if (insert) return legacy; }
      return [];
    } catch { try { db.close(); } catch {} }
  }
  return loadJson();
}

function loadJson(): Memory[] {
  try {
    const raw = fs.readFileSync(memoryPath(), 'utf-8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (x): x is Memory =>
        x &&
        typeof x.id === 'string' &&
        typeof x.content === 'string' &&
        typeof x.createdAt === 'number',
    );
  } catch {
    // 文件不存在 / 损坏 → 当成空列表
    return [];
  }
}

function dbOpenInsert(list: Memory[]): boolean {
  const db = sqliteDb(); if (!db) return false;
  try { const stmt = db.prepare('INSERT OR IGNORE INTO memories(id,content,created_at) VALUES (?,?,?)'); const tx = db.transaction((xs: Memory[]) => { for (const m of xs) stmt.run(m.id,m.content,m.createdAt); }); tx(list); db.close(); return true; } catch { try { db.close(); } catch {} return false; }
}

function save(list: Memory[]): void {
  const db = sqliteDb();
  if (db) { try { db.prepare('DELETE FROM memories').run(); const stmt = db.prepare('INSERT INTO memories(id,content,created_at) VALUES (?,?,?)'); const tx = db.transaction((xs: Memory[]) => { for (const m of xs) stmt.run(m.id,m.content,m.createdAt); }); tx(list); db.close(); return; } catch { try { db.close(); } catch {} } }
  const p = memoryPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(list, null, 2), 'utf-8');
}

/** 列出所有记忆,按创建时间正序(老的在前) */
export function listMemories(): Memory[] {
  return load().sort((a, b) => a.createdAt - b.createdAt);
}

/** 添加一条记忆。返回新条目。
 *  内部会去重 — 已经有完全相同 content 的条目则不重复添加,只把时间刷新一下。 */
export function addMemory(content: string): Memory {
  const trimmed = content.trim();
  if (!trimmed) throw new Error('memory content is empty');
  const list = load();
  const dup = list.find((m) => m.content === trimmed);
  if (dup) {
    dup.createdAt = Date.now();
    save(list);
    return dup;
  }
  const m: Memory = { id: genId(), content: trimmed, createdAt: Date.now() };
  list.push(m);
  save(list);
  return m;
}

/** 按 id 编辑记忆内容。新内容空白会抛错。存在 id 则更新返回 true,否则 false。
 *  不更新 createdAt(保留历史顺序)。 */
export function updateMemory(id: string, content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) throw new Error('memory content is empty');
  const list = load();
  const target = list.find((m) => m.id === id);
  if (!target) return false;
  target.content = trimmed;
  // 去重其他已存在相同 content 的条目，避免 SQLite UNIQUE 约束抛错导致回落 JSON 双写不一致
  const deduped = list.filter((m) => m.id === id || m.content !== trimmed);
  save(deduped);
  return true;
}

/** 按 id 或内容片段删除。返回删除的数量。
 *  match 可以是完整 id,或者 content 包含的子串(大小写敏感)。 */
export function removeMemory(match: string): number {
  if (!match) return 0;
  const list = load();
  const before = list.length;
  const next = list.filter(
    (m) => m.id !== match && !m.content.includes(match),
  );
  if (next.length === before) return 0;
  save(next);
  return before - next.length;
}

/** 清空所有记忆 — 保留接口给「设置」面板调用。 */
export function clearMemories(): void {
  save([]);
}

/** 拼成给 LLM 看的纯文本块。给 system prompt 用。
 *  空记忆时返回空字符串,调用方可据此判断要不要插入到 prompt。 */
export function formatMemoriesForPrompt(): string {
  const list = listMemories();
  if (list.length === 0) return '';
  const lines = list.map((m) => {
    const d = new Date(m.createdAt);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return `  - [${dateStr}] ${m.content}`;
  });
  return [
    '【你关于该用户的长期记忆 — 任何会话、任何模型都会看到】',
    '记忆是用户在过去对话里明确告诉你「记住」的事(偏好 / 习惯 / 个人信息 / 重要事件等)。',
    '回答时如有相关条目,自然地带入参考(不必每次主动提及"我记得你...")。',
    '条目:',
    ...lines,
  ].join('\n');
}
