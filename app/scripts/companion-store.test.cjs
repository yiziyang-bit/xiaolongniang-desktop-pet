const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const esbuild = require('esbuild');

// Bundle the TypeScript in memory so the regression check needs no build output.
const source = path.join(__dirname, '../electron/companion/store.ts');
const bundled = esbuild.buildSync({
  entryPoints: [source],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
});
const storeModule = new Module(source, module);
storeModule.filename = source;
storeModule.paths = Module._nodeModulePaths(path.dirname(source));
storeModule._compile(bundled.outputFiles[0].text, source);
const { CompanionStore, dateKey } = storeModule.exports;

const NOW = new Date(2026, 10, 8, 12, 0, 0).getTime();
const DAY_MS = 86_400_000;

function makeStore(t) {
  t.mock.method(Date, 'now', () => NOW);
  const tempRoot = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(tempRoot, 'companion-store-test-'));
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), tempRoot);
    assert.ok(path.basename(resolved).startsWith('companion-store-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return new CompanionStore(directory);
}

function record(daysAgo, decision, reason, minutesAgo = 0) {
  const moment = new Date(NOW - daysAgo * DAY_MS - minutesAgo * 60_000);
  const offsetMinutes = -moment.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? '+' : '-';
  const offset = Math.abs(offsetMinutes);
  const pad = (value) => String(value).padStart(2, '0');
  const ts = `${dateKey(moment.getTime())}T${pad(moment.getHours())}:${pad(moment.getMinutes())}:${pad(moment.getSeconds())}${offsetSign}${pad(Math.floor(offset / 60))}:${pad(offset % 60)}`;
  return {
    ts,
    intent: 'IDLE_LONG',
    world: {
      hour: moment.getHours(),
      idleSec: 1800,
      foreground: null,
      fullscreen: false,
      consecutiveErrors: 0,
      workingMinutes: 0,
      cwdHash: null,
    },
    decision,
    reason,
    line: null,
    voice: false,
    delivered: 'record_only',
    responded: null,
  };
}

test('latest records win across day files and before applying the limit', (t) => {
  const store = makeStore(t);
  store.appendDecision(record(2, 'speak', 'two-days-ago'));
  store.appendDecision(record(1, 'speak', 'yesterday'));
  // Out-of-order timestamps in one file must still be returned chronologically.
  store.appendDecision(record(0, 'speak', 'latest'));
  store.appendDecision(record(0, 'speak', 'earlier-today', 15));

  assert.deepEqual(store.listDecisions({ limit: 2 }).map((item) => item.reason), [
    'latest',
    'earlier-today',
  ]);
  assert.deepEqual(store.listDecisions().map((item) => item.reason), [
    'latest',
    'earlier-today',
    'yesterday',
    'two-days-ago',
  ]);
});

test('default history includes all retained days while explicit days still narrows it', (t) => {
  const store = makeStore(t);
  store.appendDecision(record(0, 'speak', 'today'));
  store.appendDecision(record(4, 'speak', 'november-fourth'));
  store.appendDecision(record(13, 'speak', 'oldest-retained'));
  store.appendDecision(record(14, 'speak', 'outside-retention'));

  assert.deepEqual(store.listDecisions().map((item) => item.reason), [
    'today',
    'november-fourth',
    'oldest-retained',
  ]);
  assert.deepEqual(store.listDecisions({ days: 3 }).map((item) => item.reason), ['today']);
  assert.equal(store.listDecisions({ days: 100 }).length, 3);
});

test('decision filtering happens before limiting results, including suppressed events', (t) => {
  const store = makeStore(t);
  store.appendDecision(record(0, 'speak', 'speak-today'));
  store.appendDecision(record(1, 'suppress', 'suppressed-yesterday'));
  store.appendDecision(record(2, 'bubble_only', 'quiet-hours'));
  store.appendDecision(record(3, 'suppress', 'older-suppression'));

  assert.deepEqual(store.listDecisions({ decision: 'suppress', limit: 1 }).map((item) => item.reason), [
    'suppressed-yesterday',
  ]);
  assert.deepEqual(store.listDecisions({ decision: 'bubble_only' }).map((item) => item.reason), ['quiet-hours']);
  assert.deepEqual(store.listDecisions({ decision: 'speak' }).map((item) => item.reason), ['speak-today']);
});

test('bad lines and invalid timestamps do not hide valid historical records', (t) => {
  const store = makeStore(t);
  store.appendDecision(record(0, 'speak', 'valid'));
  const file = path.join(store.directory, `decisions-${dateKey(NOW)}.jsonl`);
  fs.appendFileSync(file, '\ninvalid json\nnull\n{}\n{"ts":"not-a-date"}\n');

  assert.deepEqual(store.listDecisions().map((item) => item.reason), ['valid']);
});

test('timestamps with different UTC offsets are ordered by their instant', (t) => {
  const store = makeStore(t);
  const newer = { ...record(0, 'speak', 'newer'), ts: '2026-11-08T08:00:00+00:00' };
  const older = { ...record(0, 'speak', 'older'), ts: '2026-11-08T10:00:00+08:00' };
  store.appendDecision(newer);
  store.appendDecision(older);

  assert.deepEqual(store.listDecisions({ limit: 1 }).map((item) => item.reason), ['newer']);
});
