const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');
const esbuild = require('esbuild');

const entry = path.resolve(__dirname, '../electron/companion/engine.ts');
const code = esbuild.buildSync({
  entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false,
}).outputFiles[0].text;
const compiled = new Module(entry);
compiled.filename = entry;
compiled.paths = Module._nodeModulePaths(path.dirname(entry));
compiled._compile(code, entry);
const { CompanionEngine } = compiled.exports;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-ide-failure-'));
  const inbox = path.join(root, 'inbox');
  fs.mkdirSync(inbox);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function engine() {
    return new CompanionEngine({
      userDataDir: root,
      ideFailureInbox: inbox,
      getIdleSeconds: () => 0,
      getForeground: () => null,
      isFullscreen: () => false,
      isWindowVisible: () => true,
      onSay: () => assert.fail('failure records should never trigger speech'),
    });
  }
  function publish(fields = {}) {
    const id = randomUUID();
    const event = { version: 1, id, source: 'vscode', kind: 'terminal', exitCode: 1, timestamp: new Date().toISOString(), ...fields };
    const file = path.join(inbox, id + '.json');
    fs.writeFileSync(file, JSON.stringify(event));
    return { id, file, event };
  }
  return { root, inbox, engine, publish };
}

test('records terminal, task and PyCharm failures independently of the speaking policy', t => {
  const { engine, publish } = fixture(t);
  const terminal = publish({ stderr: 'sensitive text must never be saved' });
  const task = publish({ kind: 'task', exitCode: 7 });
  const pycharm = publish({ source: 'pycharm', kind: 'run', exitCode: 2 });
  const pet = engine();
  pet.tick();
  const records = pet.getDecisions({ decision: 'recorded' });
  assert.deepEqual(new Set(records.map(r => r.ideFailure.id)), new Set([terminal.id, task.id, pycharm.id]));
  assert(records.every(r => r.intent === 'IDE_RUN_FAILED' && r.world === null && r.delivered === 'record_only'));
  assert.equal(records.find(r => r.ideFailure.id === task.id).ideFailure.exitCode, 7);
  assert.equal(records.find(r => r.ideFailure.id === pycharm.id).ideFailure.source, 'pycharm');
  assert(!JSON.stringify(records).includes('sensitive text'));
  assert.equal(pet.getSummary().today.spokenCount, 0);
  assert.equal(pet.getDecisions({ decision: 'speak' }).length, 0);
  for (const { file } of [terminal, task, pycharm]) assert(!fs.existsSync(file));
});

test('retries a failed save and does not duplicate an already saved record after restart', t => {
  const { root, engine, publish } = fixture(t);
  const item = publish();
  const pet = engine();
  const logDir = path.join(root, 'companion');
  fs.rmdirSync(logDir);
  fs.writeFileSync(logDir, 'not a directory');
  pet.tick();
  assert(fs.existsSync(item.file));
  fs.unlinkSync(logDir);
  fs.mkdirSync(logDir);
  pet.tick();
  assert(!fs.existsSync(item.file));
  fs.writeFileSync(item.file, JSON.stringify(item.event));
  const restarted = engine();
  restarted.tick();
  assert(!fs.existsSync(item.file));
  assert.equal(restarted.getDecisions({ decision: 'recorded' }).length, 1);
});

test('ignores successes, malformed files and unrelated inbox entries', t => {
  const { inbox, engine, publish } = fixture(t);
  const zero = publish({ exitCode: 0 });
  const invalid = publish({ source: 'pycharm', kind: 'terminal' });
  const mismatch = publish({ id: randomUUID() });
  const wrongTime = publish({ timestamp: 'not a timestamp' });
  const malformed = path.join(inbox, randomUUID() + '.json');
  const temp = path.join(inbox, randomUUID() + '.tmp');
  fs.writeFileSync(malformed, '{');
  fs.writeFileSync(temp, '{}');
  const pet = engine();
  pet.tick();
  assert.equal(pet.getDecisions({ decision: 'recorded' }).length, 0);
  for (const file of [zero.file, invalid.file, mismatch.file, wrongTime.file, malformed, temp]) {
    assert(fs.existsSync(file));
  }
});
