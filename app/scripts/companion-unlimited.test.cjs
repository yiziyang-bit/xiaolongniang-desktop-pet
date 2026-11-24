const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');
const esbuild = require('esbuild');

function load(relative) {
  const entry = path.resolve(__dirname, '../electron/companion', relative);
  const code = esbuild.buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
  const compiled = new Module(entry);
  compiled.filename = entry;
  compiled.paths = Module._nodeModulePaths(path.dirname(entry));
  compiled._compile(code, entry);
  return compiled.exports;
}
const { CompanionEngine } = load('engine.ts');
const { decide } = load('policy.ts');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-unlimited-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = { idle: 0, fullscreen: false, events: [], says: [] };
  const engine = new CompanionEngine({
    userDataDir: root,
    ideFailureInbox: path.join(root, 'inbox'),
    getIdleSeconds: () => runtime.idle,
    getForeground: () => null,
    isFullscreen: () => runtime.fullscreen,
    isWindowVisible: () => true,
    onSay: (payload) => runtime.says.push(payload),
  });
  Object.assign(engine.state.prefs, { enabled: true, recordOnly: false, frequency: 'unlimited', quietStartHour: 0, quietStartMinute: 0, quietEndHour: 0, quietEndMinute: 0 });
  engine.watcher.recentEvents = () => runtime.events;
  return { engine, runtime };
}

test('unlimited bypasses total, per-intent and cooldown limits while normal modes retain them', () => {
  const now = Date.now();
  const candidate = { intent: 'IDLE_LONG', priority: 40, context: {} };
  const world = { now, fullscreen: false, lastUserInteractionAt: null, windowVisible: true };
  const prefs = { enabled: true, frequency: 'unlimited', quietStartHour: 0, quietStartMinute: 0, quietEndHour: 0, quietEndMinute: 0 };
  const stats = { daily: { date: '2026-11-12', spokenCount: 100, candidateCount: 100, perIntent: { IDLE_LONG: 100 } }, lastSpokeAt: now, ignoredCount: { IDLE_LONG: 10 } };
  assert.equal(decide(candidate, world, prefs, stats).decision, 'speak');
  assert.equal(decide(candidate, world, { ...prefs, frequency: 'quiet' }, stats).reason, 'daily_cap');
  assert.equal(decide(candidate, world, { ...prefs, frequency: 'normal' }, { ...stats, daily: { ...stats.daily, spokenCount: 0 } }).reason, 'cooldown');
  assert.equal(decide(candidate, world, { ...prefs, frequency: 'lively' }, { ...stats, lastSpokeAt: null, daily: { ...stats.daily, spokenCount: 0 } }).reason, 'intent_daily_cap');
});

test('unlimited speaks once per continuous condition and can speak repeatedly after it ends', t => {
  const { engine, runtime } = fixture(t);
  for (let n = 0; n < 35; n++) {
    runtime.idle = 1801;
    engine.tick();
    engine.tick();
    runtime.idle = 0;
    engine.tick();
  }
  assert.equal(runtime.says.length, 35);
  assert(runtime.says.every(s => s.intent === 'IDLE_LONG' && s.voice === true));
  assert.equal(engine.getSummary().today.spokenCount, 35);
});

test('a suppressed continuous condition can speak after fullscreen ends', t => {
  const { engine, runtime } = fixture(t);
  runtime.idle = 1801;
  runtime.fullscreen = true;
  engine.tick();
  assert.equal(runtime.says.length, 0);
  runtime.fullscreen = false;
  engine.tick();
  engine.tick();
  assert.equal(runtime.says.length, 1);
});

test('a success event suppressed by fullscreen is not marked handled before delivery', t => {
  const { engine, runtime } = fixture(t);
  const now = Date.now();
  runtime.events = [
    { ts: now - 2, kind: 'CMD_RESULT', ok: false, sessionId: 'test' },
    { ts: now - 1, kind: 'CMD_RESULT', ok: false, sessionId: 'test' },
    { ts: now, kind: 'CMD_RESULT', ok: true, sessionId: 'test' },
  ];
  runtime.fullscreen = true;
  engine.tick();
  assert.equal(engine.state.lastSuccessHandledTs, null);
  runtime.fullscreen = false;
  engine.tick();
  engine.tick();
  assert.equal(runtime.says.length, 1);
  assert.equal(runtime.says[0].intent, 'SUCCESS_AFTER_FAILS');
  assert.equal(engine.state.lastSuccessHandledTs, now);
});
