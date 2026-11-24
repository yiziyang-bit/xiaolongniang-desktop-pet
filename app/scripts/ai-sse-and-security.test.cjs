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

const { createSseStreamDecoder } = loadTs('../electron/sse-decoder.ts');
const { sanitizeHastTree } = loadTs('../src/ui/rehype-safe-html.ts');
const { validateExternalHttpUrl, isPrivateOrLocalIp, validatePublicFetchUrl } = loadTs('../electron/url-safety.ts');
const { isSelfForegroundApp } = loadTs('../electron/proactive-aware.ts', {
  electron: {},
  'get-windows': {},
  './config-store.js': {
    loadConfig: () => ({}),
    getProactiveConfig: () => ({ enabled: false, awareApps: false, awareLongStay: false }),
  },
});

test('createSseStreamDecoder decodes Chinese and 4-byte emoji across arbitrary byte splits without replacement chars', () => {
  const payload = Buffer.from(
    'data: ' + JSON.stringify({ choices: [{ delta: { content: '中文正常🐉' }, finish_reason: null }] }) + '\n\n' +
    'data: ' + JSON.stringify({ choices: [{ delta: { content: '尾行无换行' }, finish_reason: 'stop' }] }),
    'utf8',
  );
  const wordStart = payload.indexOf(Buffer.from('中文正常🐉'));
  // 分别测试每个字节切分点（涵盖 3 字节汉字和 4 字节 emoji 的内部字节边界）
  for (let split = wordStart + 1; split < wordStart + 16; split++) {
    const accums = new Map();
    const decoder = createSseStreamDecoder(accums);
    const first = decoder.push(payload.subarray(0, split));
    const second = decoder.push(payload.subarray(split));
    const tail = decoder.flush();
    const answer = [...first.chunks, ...second.chunks, ...tail.chunks]
      .filter((c) => c.kind === 'answer')
      .map((c) => c.text)
      .join('');
    assert.equal(answer, '中文正常🐉尾行无换行');
    assert.ok(!answer.includes('\uFFFD'));
  }
});

test('sanitizeHastTree strips dangerous tags/events/schemes while preserving safe markdown HTML', () => {
  const tree = {
    type: 'root',
    children: [
      { type: 'element', tagName: 'script', properties: {}, children: [{ type: 'text', value: 'alert(1)' }] },
      { type: 'element', tagName: 'iframe', properties: { src: 'https://evil.example', srcDoc: '<p>x</p>' }, children: [] },
      {
        type: 'element',
        tagName: 'img',
        properties: { src: 'javascript:alert(1)', onError: 'alert(1)', alt: 'bad' },
        children: [],
      },
      {
        type: 'element',
        tagName: 'img',
        properties: { src: 'pet://app/icon.png', alt: 'ok' },
        children: [],
      },
      {
        type: 'element',
        tagName: 'a',
        properties: { href: 'java\nscript:alert(1)', onClick: 'evil()' },
        children: [{ type: 'text', value: 'bad link' }],
      },
      {
        type: 'element',
        tagName: 'details',
        properties: { open: true },
        children: [
          { type: 'element', tagName: 'summary', properties: {}, children: [{ type: 'text', value: '详情' }] },
          { type: 'element', tagName: 'sub', properties: {}, children: [{ type: 'text', value: '2' }] },
          { type: 'element', tagName: 'sup', properties: {}, children: [{ type: 'text', value: '3' }] },
        ],
      },
    ],
  };

  const out = sanitizeHastTree(tree);
  assert.equal(out.children.length, 4);
  assert.equal(out.children[0].tagName, 'img');
  assert.equal('src' in out.children[0].properties, false);
  assert.equal('onError' in out.children[0].properties, false);
  assert.equal(out.children[1].properties.src, 'pet://app/icon.png');
  assert.equal(out.children[2].tagName, 'a');
  assert.equal('href' in out.children[2].properties, false);
  assert.equal('onClick' in out.children[2].properties, false);
  assert.equal(out.children[3].tagName, 'details');
  assert.equal(out.children[3].children[0].tagName, 'summary');
  assert.equal(out.children[3].children[1].tagName, 'sub');
  assert.equal(out.children[3].children[2].tagName, 'sup');
});

test('validateExternalHttpUrl only permits http and https schemes', () => {
  assert.equal(validateExternalHttpUrl('https://github.com/test'), 'https://github.com/test');
  assert.equal(validateExternalHttpUrl(' http://127.0.0.1:8080/ok '), 'http://127.0.0.1:8080/ok');
  assert.throws(() => validateExternalHttpUrl('file:///C:/Windows/System32/calc.exe'));
  assert.throws(() => validateExternalHttpUrl('ms-msdt:/id'));
  assert.throws(() => validateExternalHttpUrl('javascript:alert(1)'));
  assert.throws(() => validateExternalHttpUrl(''));
});

test('sanitizeHastTree blocks SVG/MathML scriptable elements while keeping safe octicon SVG', () => {
  const tree = {
    type: 'root',
    children: [
      {
        type: 'element',
        tagName: 'svg',
        properties: { viewBox: '0 0 16 16' },
        children: [
          { type: 'element', tagName: 'path', properties: { d: 'M0 0h16v16H0z' }, children: [] },
          { type: 'element', tagName: 'animate', properties: { attributeName: 'href', values: 'javascript:alert(1)' }, children: [] },
          { type: 'element', tagName: 'foreignObject', properties: {}, children: [{ type: 'text', value: 'bad' }] },
          { type: 'element', tagName: 'use', properties: { href: 'https://evil.example/x.svg#p' }, children: [] },
        ],
      },
      {
        type: 'element',
        tagName: 'math',
        properties: { href: 'javascript:alert(1)' },
        children: [],
      },
    ],
  };
  const out = sanitizeHastTree(tree);
  assert.equal(out.children.length, 1);
  assert.equal(out.children[0].tagName, 'svg');
  assert.equal(out.children[0].children.length, 1);
  assert.equal(out.children[0].children[0].tagName, 'path');
});

test('isSelfForegroundApp recognizes packaged XiaolongniangDesktopPet and self PID', () => {
  assert.equal(isSelfForegroundApp('XiaolongniangDesktopPet.exe', 9999, 1234), true);
  assert.equal(isSelfForegroundApp('electron.exe', 9999, 1234), true);
  assert.equal(isSelfForegroundApp('小龙娘桌宠', 9999, 1234), true);
  assert.equal(isSelfForegroundApp('Code.exe', 1234, 1234), true);
  assert.equal(isSelfForegroundApp('Code.exe', 5678, 1234), false);
  assert.equal(isSelfForegroundApp('msedge.exe', 5678, 1234), false);
});

function buildMinimalPdf(text) {
  const stream = `BT /F1 18 Tf 24 72 Td (${text}) Tj ET`;
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += obj;
  }
  const xrefStart = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, 'utf8'));
}

test('pdf-parse v2 PDFParse extracts text from PDF Uint8Array cleanly', async () => {
  const mod = await import('pdf-parse');
  assert.equal(typeof mod.PDFParse, 'function');
  const parser = new mod.PDFParse({ data: buildMinimalPdf('Hello PDF') });
  try {
    const res = await parser.getText();
    assert.ok(String(res?.text ?? '').includes('Hello PDF'));
  } finally {
    await parser.destroy?.();
  }
});

test('validatePublicFetchUrl blocks loopback, private LAN, cloud metadata, IPv6-mapped and DNS rebinding SSRF', async () => {
  assert.equal(isPrivateOrLocalIp('127.0.0.1'), true);
  assert.equal(isPrivateOrLocalIp('10.0.0.8'), true);
  assert.equal(isPrivateOrLocalIp('172.20.1.2'), true);
  assert.equal(isPrivateOrLocalIp('192.168.1.1'), true);
  assert.equal(isPrivateOrLocalIp('169.254.169.254'), true);
  assert.equal(isPrivateOrLocalIp('::1'), true);
  assert.equal(isPrivateOrLocalIp('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateOrLocalIp('::ffff:7f00:0001'), true);
  assert.equal(isPrivateOrLocalIp('93.184.216.34'), false);

  await assert.rejects(() => validatePublicFetchUrl('http://127.0.0.1:11434/api/tags'));
  await assert.rejects(() => validatePublicFetchUrl('http://localhost:8080/secret'));
  await assert.rejects(() => validatePublicFetchUrl('http://169.254.169.254/latest/meta-data/'));
  await assert.rejects(() => validatePublicFetchUrl('http://[::1]:3000/'));
  await assert.rejects(() =>
    validatePublicFetchUrl('https://rebind.example.com/data', async () => [{ address: '10.0.0.5', family: 4 }]),
  );

  const okUrl = await validatePublicFetchUrl('https://example.com/news', async () => [
    { address: '93.184.216.34', family: 4 },
  ]);
  assert.equal(okUrl, 'https://example.com/news');
});
