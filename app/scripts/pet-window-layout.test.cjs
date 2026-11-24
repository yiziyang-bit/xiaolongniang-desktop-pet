const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');
const esbuild = require('esbuild');

const source = path.resolve(__dirname, '../electron/pet-window-layout.ts');
const compiled = esbuild.buildSync({
  entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false,
}).outputFiles[0].text;
const loaded = new Module(source);
loaded.filename = source;
loaded._compile(compiled, source);
const { getPetWindowBounds, clampModelToDisplay } = loaded.exports;

const display = { x: 0, y: 0, width: 1536, height: 864 };
const right = (rect) => rect.x + rect.width;
const bottom = (rect) => rect.y + rect.height;

function assertContained(inner, outer) {
  assert(inner.x >= outer.x && inner.y >= outer.y, 'top and left are inside');
  assert(right(inner) <= right(outer) && bottom(inner) <= bottom(outer), 'bottom and right are inside');
}

test('expanded menu keeps the visible lower part of an enlarged model', () => {
  const model = { x: 600, y: 250, width: 396, height: 588 };
  const bounds = getPetWindowBounds(model, display, 'expanded');
  assertContained(model, bounds);
  assertContained(bounds, display);
  assert(bounds.width < display.width);
});

test('compact window moved to the upper-right keeps room for the bubble on the left', () => {
  const model = { x: 1201, y: 5, width: 330, height: 490 };
  const bounds = getPetWindowBounds(model, display, 'compact');
  assertContained(model, bounds);
  assertContained(bounds, display);
  assert(model.x - bounds.x >= 244);
  assert(model.y - bounds.y < 240);
  assert(bounds.width < display.width && bounds.height < display.height);
});

test('small model near the left edge keeps the full head bubble width on its display', () => {
  const model = { x: 2, y: 310, width: 99, height: 147 };
  const bounds = getPetWindowBounds(model, display, 'compact');
  assertContained(model, bounds);
  assertContained(bounds, display);
  assert(model.y - bounds.y >= 240);
  assert(bounds.width >= 232 + 16);
  assert(right(bounds) - right(model) >= 72);
});

test('compact window can show the root menu at minimum scale without resizing', () => {
  const nearTop = { x: 500, y: 5, width: 99, height: 147 };
  const sideBubble = getPetWindowBounds(nearTop, display, 'compact');
  assert(sideBubble.height >= 400);
  assert(nearTop.x - sideBubble.x >= 72);
  assert(right(sideBubble) - right(nearTop) >= 260);

  const nearBottom = { ...nearTop, y: 500 };
  const headBubble = getPetWindowBounds(nearBottom, display, 'compact');
  assert(nearBottom.x - headBubble.x >= 72);
  assert(right(headBubble) - right(nearBottom) >= 72);
});

test('negative display coordinates and model portions outside the screen stay stable', () => {
  const secondary = { x: -1536, y: -180, width: 1536, height: 864 };
  const model = { x: -1560, y: -200, width: 330, height: 490 };
  const visible = { x: secondary.x, y: secondary.y, width: right(model) - secondary.x, height: bottom(model) - secondary.y };
  const bounds = getPetWindowBounds(model, secondary, 'compact');
  assertContained(visible, bounds);
  assertContained(bounds, secondary);
  assert(right(bounds) - right(model) >= 244);
});

test('a model taller than the screen gets the full visible height on expansion', () => {
  const model = { x: 600, y: -100, width: 396, height: 980 };
  const bounds = getPetWindowBounds(model, display, 'expanded');
  assert.equal(bounds.y, display.y);
  assert.equal(bounds.height, display.height);
  assert(bounds.width < display.width);
});

test('clampModelToDisplay brings completely off-screen positive and negative coordinates back inside display', () => {
  const farRight = clampModelToDisplay({ x: display.width + 10000, y: 200, width: 330, height: 490 }, display);
  assert.equal(farRight.x, display.width - 12 - 330);
  assert.equal(farRight.y, 200);

  const farTopLeft = clampModelToDisplay({ x: -2000, y: -1500, width: 330, height: 490 }, display);
  assert.equal(farTopLeft.x, 12);
  assert.equal(farTopLeft.y, 12);

  const secondary = { x: -1536, y: -180, width: 1536, height: 864 };
  const offSecondary = clampModelToDisplay({ x: 500, y: -2000, width: 330, height: 490 }, secondary);
  assert.equal(offSecondary.x, secondary.x + secondary.width - 12 - 330);
  assert.equal(offSecondary.y, secondary.y + 12);
});

test('clampModelToDisplay preserves partial edge positions with enough visible area and handles oversized models', () => {
  const partialEdge = { x: -120, y: -150, width: 330, height: 490 };
  assert.deepEqual(clampModelToDisplay(partialEdge, display), partialEdge);

  const oversized = clampModelToDisplay({ x: 3000, y: 3000, width: 1800, height: 1200 }, display);
  assert.equal(oversized.x, 0);
  assert.equal(oversized.y, 0);
});
