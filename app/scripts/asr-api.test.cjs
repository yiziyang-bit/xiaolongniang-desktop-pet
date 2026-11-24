const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { test } = require('node:test');
const esbuild = require('esbuild');

function loadTs(relPath, mocks = {}) {
  const source = path.resolve(__dirname, relPath);
  const compiled = esbuild.buildSync({
    entryPoints: [source],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: Object.keys(mocks),
    write: false,
  }).outputFiles[0].text;
  const mod = new Module(source);
  mod.filename = source;
  mod.paths = Module._nodeModulePaths(path.dirname(source));
  const origRequire = mod.require.bind(mod);
  mod.require = (id) => (id in mocks ? mocks[id] : origRequire(id));
  mod._compile(compiled, source);
  return mod.exports;
}

const { encodeMonoWav16, createSilentWav16, computeRms } = loadTs('../shared/asr-templates.ts');
const {
  resolveAsrEndpointUrl,
  resolveEffectiveAsrConfig,
  buildAsrMultipartBody,
  parseAsrResponse,
} = loadTs('../electron/asr-client.ts', {
  electron: { net: {} },
  './config-store.js': { loadConfig: () => ({ baseURL: '', apiKey: '', model: '', skills: [], activeSkillId: 'default', memory: '' }) },
});

test('encodeMonoWav16 downsamples 48kHz Float32 PCM to valid 16kHz 16-bit mono RIFF WAVE', () => {
  const inSamples = new Float32Array(4800); // 100ms @ 48kHz -> 1600 samples @ 16kHz
  for (let i = 0; i < inSamples.length; i++) {
    inSamples[i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.5;
  }
  assert.ok(computeRms(inSamples) > 0.3);
  const wav = encodeMonoWav16(inSamples, 48000, 16000);
  const buf = Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.toString('ascii', 8, 12), 'WAVE');
  assert.equal(buf.toString('ascii', 12, 16), 'fmt ');
  assert.equal(buf.readUInt16LE(20), 1); // PCM
  assert.equal(buf.readUInt16LE(22), 1); // mono
  assert.equal(buf.readUInt32LE(24), 16000); // 16kHz
  assert.equal(buf.readUInt16LE(34), 16); // 16-bit
  assert.equal(buf.toString('ascii', 36, 40), 'data');
  assert.equal(buf.readUInt32LE(40), 1600 * 2);
  assert.equal(buf.length, 44 + 1600 * 2);
});

test('resolveAsrEndpointUrl normalizes baseURLs and rejects unsafe schemes', () => {
  assert.equal(
    resolveAsrEndpointUrl('https://api.siliconflow.cn/v1/'),
    'https://api.siliconflow.cn/v1/audio/transcriptions',
  );
  assert.equal(
    resolveAsrEndpointUrl('https://api.openai.com/v1/chat/completions'),
    'https://api.openai.com/v1/audio/transcriptions',
  );
  assert.equal(
    resolveAsrEndpointUrl('https://example.com/v1/audio/transcriptions'),
    'https://example.com/v1/audio/transcriptions',
  );
  assert.throws(() => resolveAsrEndpointUrl('file:///C:/test'));
  assert.throws(() => resolveAsrEndpointUrl(''));
});

test('resolveEffectiveAsrConfig reuses chat key only on same origin and never leaks key cross-origin', () => {
  const baseCfg = {
    baseURL: 'https://api.siliconflow.cn/v1',
    apiKey: 'sk-chat-secret',
    speechAsr: {
      mode: 'api',
      baseURL: '',
      apiKey: '',
      model: 'FunAudioLLM/SenseVoiceSmall',
      language: 'zh',
    },
  };
  const sameOrigin = resolveEffectiveAsrConfig(baseCfg);
  assert.equal(sameOrigin.endpointUrl, 'https://api.siliconflow.cn/v1/audio/transcriptions');
  assert.equal(sameOrigin.apiKey, 'sk-chat-secret');
  assert.equal(sameOrigin.model, 'FunAudioLLM/SenseVoiceSmall');

  // 不同域名且未单独填 ASR apiKey 时，绝不能把对话 apiKey 发往第三方域名
  assert.throws(() =>
    resolveEffectiveAsrConfig({
      ...baseCfg,
      speechAsr: {
        mode: 'api',
        baseURL: 'https://other-asr.example.com/v1',
        apiKey: '',
        model: 'whisper-1',
      },
    }),
  );

  // 本地服务允许免 key
  const localCfg = resolveEffectiveAsrConfig({
    ...baseCfg,
    speechAsr: {
      mode: 'api',
      baseURL: 'http://127.0.0.1:8000/v1',
      apiKey: '',
      model: 'whisper-1',
    },
  });
  assert.equal(localCfg.apiKey, '');
});

test('buildAsrMultipartBody and parseAsrResponse handle OpenAI transcription payloads and errors', () => {
  const wav = createSilentWav16(100, 16000);
  const body = buildAsrMultipartBody(wav, { model: 'whisper-1', language: 'zh' }, 'Bound123');
  const textView = body.toString('latin1');
  assert.ok(textView.includes('name="model"\r\n\r\nwhisper-1'));
  assert.ok(textView.includes('name="language"\r\n\r\nzh'));
  assert.ok(textView.includes('filename="speech.wav"'));
  assert.ok(textView.includes('RIFF'));

  assert.equal(parseAsrResponse(200, '{"text":"  你好，小龙娘  "}'), '你好，小龙娘');
  assert.equal(parseAsrResponse(200, '纯文本返回'), '纯文本返回');
  assert.throws(
    () => parseAsrResponse(401, '{"error":{"message":"Invalid API key"}}'),
    /HTTP 401.*Invalid API key/,
  );
});
