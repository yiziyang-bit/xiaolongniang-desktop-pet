const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const esbuild = require('esbuild');

const source = path.join(__dirname, '../electron/companion/speech-queue.ts');
const bundled = esbuild.buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false });
const mod = new Module(source, module);
mod.filename = source;
mod.paths = Module._nodeModulePaths(path.dirname(source));
mod._compile(bundled.outputFiles[0].text, source);
const { CompanionSpeechQueue } = mod.exports;
const turn = () => new Promise((resolve) => setImmediate(resolve));

test('waits for ongoing chat, then serializes companion speech despite synchronous idle', async () => {
  const spoken = [];
  const queue = new CompanionSpeechQueue((text) => {
    // CloneSpeech.speak() calls stop(), which synchronously emits idle.
    queue.setState('clone', 'idle');
    spoken.push(text);
    queue.setState('clone', 'preparing');
    return true;
  }, () => assert.fail('speech should start'));
  queue.setState('local', 'speaking');
  queue.enqueue('first');
  queue.enqueue('second');
  await turn();
  assert.deepEqual(spoken, []);
  queue.setState('local', 'idle');
  await turn();
  await turn();
  assert.deepEqual(spoken, ['first']);
  queue.setState('clone', 'idle');
  await turn();
  assert.deepEqual(spoken, ['first', 'second']);
  queue.dispose();
});

test('unavailable speech advances the queue and explicit stop cancels queued speech', async () => {
  const attempted = [];
  let failures = 0;
  const queue = new CompanionSpeechQueue((text) => { attempted.push(text); return false; }, () => { failures += 1; });
  queue.enqueue('first');
  queue.enqueue('second');
  await turn();
  await turn();
  assert.deepEqual(attempted, ['first', 'second']);
  assert.equal(failures, 2);
  queue.setState('clone', 'speaking');
  queue.enqueue('cancelled');
  queue.clear();
  queue.setState('clone', 'idle');
  await turn();
  assert.deepEqual(attempted, ['first', 'second']);
  queue.dispose();
});
