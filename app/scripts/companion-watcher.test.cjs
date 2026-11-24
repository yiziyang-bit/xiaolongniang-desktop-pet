const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');
const esbuild = require('esbuild');

const source = path.resolve(__dirname, '../electron/companion/session-watcher.ts');
const compiled = esbuild.buildSync({
  entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false,
}).outputFiles[0].text;
const loaded = new Module(source);
loaded.filename = source;
loaded.paths = Module._nodeModulePaths(path.dirname(source));
loaded._compile(compiled, source);
const { CodexSessionWatcher } = loaded.exports;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-watcher-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeSession(root, day, name, content, mtime) {
  const folder = path.join(root, ...day.split('-'));
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, 'rollout-' + name + '.jsonl');
  fs.writeFileSync(file, content);
  if (mtime !== undefined) fs.utimesSync(file, mtime / 1000, mtime / 1000);
  return file;
}

function event(ts, tool = 'test') {
  return JSON.stringify({
    timestamp: new Date(ts).toISOString(),
    type: 'response_item',
    payload: { type: 'function_call', name: tool },
  }) + '\n';
}

test('active old conversation is discovered and stays incremental', async t => {
  const root = fixture(t), now = new Date(2026, 10, 8, 12).getTime();
  const old = writeSession(root, '2026-11-01', 'old-active', event(now, 'first'), now);
  for (let i = 0; i < 14; i++) {
    writeSession(root, '2026-11-08', 'inactive-' + i, event(now - 600000, 'inactive'), now - 600000);
  }
  const watcher = new CodexSessionWatcher({ sessionsRoot: root, now: () => now });
  await watcher.poll();
  assert(watcher.recentEvents().some(e => e.tool === 'first'));
  fs.appendFileSync(old, event(now + 1000, 'second'));
  fs.utimesSync(old, (now + 1000) / 1000, (now + 1000) / 1000);
  await watcher.poll();
  assert.equal(watcher.recentEvents().filter(e => e.tool === 'first').length, 1);
  assert(watcher.recentEvents().some(e => e.tool === 'second'));
});

test('new conversations are discovered between full directory scans', async t => {
  const root = fixture(t);
  let now = new Date(2026, 10, 8, 12).getTime();
  const watcher = new CodexSessionWatcher({ sessionsRoot: root, now: () => now });
  await watcher.poll();
  writeSession(root, '2026-11-08', 'new-today', event(now, 'today'));
  now += 2000;
  await watcher.poll();
  assert(watcher.recentEvents().some(e => e.tool === 'today'));
  writeSession(root, '2026-09-01', 'imported-active', event(now, 'imported'));
  now += 31000;
  await watcher.poll();
  assert(watcher.recentEvents().some(e => e.tool === 'imported'));
});

for (const megabytes of [3, 6]) {
  test('reads newest events and unfinished final line in ' + megabytes + ' MB file', async t => {
    const root = fixture(t), now = Date.now();
    const filler = JSON.stringify({ type: 'ignored', text: 'x'.repeat(512 * 1024) }) + '\n';
    const next = event(now + 1000, 'completed-later');
    const split = Math.floor(next.length / 2);
    const file = writeSession(root, '2026-11-01', 'large', filler.repeat(megabytes * 2) + event(now, 'tail') + next.slice(0, split));
    const watcher = new CodexSessionWatcher({ sessionsRoot: root });
    await watcher.poll();
    assert(watcher.recentEvents().some(e => e.tool === 'tail'));
    assert(!watcher.recentEvents().some(e => e.tool === 'completed-later'));
    fs.appendFileSync(file, next.slice(split));
    await watcher.poll();
    assert.equal(watcher.recentEvents().filter(e => e.tool === 'tail').length, 1);
    assert(watcher.recentEvents().some(e => e.tool === 'completed-later'));
  });
}

test('UTF-8 character and JSON line may span separate file writes', async t => {
  const root = fixture(t), data = Buffer.from(event(Date.now(), '鹈鹕'));
  const split = data.indexOf(Buffer.from('鹈')) + 1;
  const file = writeSession(root, '2026-11-01', 'utf8', data.subarray(0, split));
  const watcher = new CodexSessionWatcher({ sessionsRoot: root });
  await watcher.poll();
  fs.appendFileSync(file, data.subarray(split));
  await watcher.poll();
  assert.equal(watcher.recentEvents()[0].tool, '鹈鹕');
});

test('truncated files are read again', async t => {
  const root = fixture(t), now = Date.now();
  const file = writeSession(root, '2026-11-01', 'truncate', event(now, 'long-original-name'));
  const watcher = new CodexSessionWatcher({ sessionsRoot: root });
  await watcher.poll();
  fs.writeFileSync(file, event(now + 1000, 'new'));
  await watcher.poll();
  assert(watcher.recentEvents().some(e => e.tool === 'new'));
});

test('reading older sessions cannot evict the newest retained events', async t => {
  const root = fixture(t), now = Date.now();
  writeSession(root, '2026-11-01', 'recent', event(now, 'latest'), now);
  const older = Array.from({ length: 240 }, (_, i) => event(now - 100000 + i, 'old')).join('');
  writeSession(root, '2026-11-02', 'older', older, now - 1000);
  const watcher = new CodexSessionWatcher({ sessionsRoot: root });
  await watcher.poll();
  const events = watcher.recentEvents();
  assert.equal(events.length, 200);
  assert.equal(events.at(-1).tool, 'latest');
  assert(events.every((e, i) => i === 0 || e.ts >= events[i - 1].ts));
});
