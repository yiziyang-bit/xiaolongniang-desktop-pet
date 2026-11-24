import type { Rectangle } from 'electron';

export type PetWindowMode = 'compact' | 'expanded' | 'full';

const MODEL_PADDING = 48;
const BUBBLE_HEIGHT = 270;
const BUBBLE_SIDE_SPACE = 260;
const BUBBLE_WIDTH = 232;
// Seven 48px menu buttons, six 8px gaps and a viewport margin at either end.
const COMPACT_MENU_HEIGHT = 400;
const COMPACT_MENU_SIDE_SPACE = 72;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampAxisToDisplay(
  pos: number,
  size: number,
  displayStart: number,
  displaySize: number,
  margin: number,
): number {
  const minVisible = Math.min(48, Math.ceil(size * 0.25));
  const overlap = Math.min(pos + size, displayStart + displaySize) - Math.max(pos, displayStart);
  if (overlap >= minVisible) return pos;
  const minPos = size + margin * 2 <= displaySize ? displayStart + margin : displayStart + displaySize - size;
  const maxPos = size + margin * 2 <= displaySize ? displayStart + displaySize - margin - size : displayStart;
  return clamp(Math.round(pos), Math.min(minPos, maxPos), Math.max(minPos, maxPos));
}

/**
 * 当保存或传入的模型屏幕矩形几乎或完全离开所在显示器时，将模型安全拉回屏幕内。
 * 若模型在屏幕边缘仍有足够可见区域（如用户有意贴边/跨屏放置），则保持原坐标不变。
 */
export function clampModelToDisplay(model: Rectangle, display: Rectangle): Rectangle {
  const margin = 12;
  const x = clampAxisToDisplay(model.x, model.width, display.x, display.width, margin);
  const y = clampAxisToDisplay(model.y, model.height, display.y, display.height, margin);
  return { x, y, width: model.width, height: model.height };
}

/**
 * Place one window axis on the display while keeping the model and its
 * on-screen animation margin inside the viewport.
 */
function fitAxis(
  displayStart: number,
  displaySize: number,
  modelStart: number,
  modelEnd: number,
  preferredStart: number,
  preferredSize: number,
): { start: number; size: number } {
  const displayEnd = displayStart + displaySize;
  const keepStart = clamp(Math.floor(modelStart - MODEL_PADDING), displayStart, displayEnd);
  const keepEnd = clamp(Math.ceil(modelEnd + MODEL_PADDING), displayStart, displayEnd);
  const size = Math.min(displaySize, Math.max(Math.ceil(preferredSize), keepEnd - keepStart));
  const minStart = Math.max(displayStart, keepEnd - size);
  const maxStart = Math.min(displayEnd - size, keepStart);
  return { start: clamp(Math.round(preferredStart), minStart, maxStart), size };
}

export function getPetWindowBounds(model: Rectangle, display: Rectangle, mode: PetWindowMode): Rectangle {
  if (mode === 'full') return display;

  const right = display.x + display.width;
  const bottom = display.y + display.height;
  const modelRight = model.x + model.width;
  const modelBottom = model.y + model.height;
  const leftSpace = clamp(model.x - display.x, 0, display.width);
  const rightSpace = clamp(right - modelRight, 0, display.width);
  const visibleWidth = clamp(modelRight, display.x, right) - clamp(model.x, display.x, right);
  const visibleHeight = clamp(modelBottom, display.y, bottom) - clamp(model.y, display.y, bottom);
  const bubbleAbove = model.y >= display.y + BUBBLE_HEIGHT;
  const bubbleOnLeft = rightSpace < BUBBLE_SIDE_SPACE && leftSpace > rightSpace;
  const horizontalPadding = Math.max(COMPACT_MENU_SIDE_SPACE, Math.ceil((BUBBLE_WIDTH - model.width) / 2 + 12));
  const compactTopPadding = bubbleAbove ? BUBBLE_HEIGHT : MODEL_PADDING;

  // 90% is a preference for the expanded panel. fitAxis may grow an axis
  // further when that is needed to keep the entire visible model in view.
  const expandedWidth = Math.min(Math.floor(display.width * 0.9), Math.max(800, visibleWidth + 420));
  const expandedHeight = Math.min(Math.floor(display.height * 0.9), Math.max(600, visibleHeight + 318));
  const preferredWidth = mode === 'expanded'
    ? expandedWidth
    : visibleWidth + (bubbleAbove ? horizontalPadding * 2 : BUBBLE_SIDE_SPACE + COMPACT_MENU_SIDE_SPACE);
  const preferredHeight = mode === 'expanded'
    ? expandedHeight
    : Math.max(COMPACT_MENU_HEIGHT, visibleHeight + compactTopPadding + MODEL_PADDING);
  const preferredX = mode === 'expanded'
    ? model.x + model.width / 2 - preferredWidth / 2
    : model.x - (bubbleAbove ? horizontalPadding : bubbleOnLeft ? BUBBLE_SIDE_SPACE : COMPACT_MENU_SIDE_SPACE);
  const preferredY = model.y - (mode === 'expanded' ? BUBBLE_HEIGHT : compactTopPadding);
  const horizontal = fitAxis(display.x, display.width, model.x, modelRight, preferredX, preferredWidth);
  const vertical = fitAxis(display.y, display.height, model.y, modelBottom, preferredY, preferredHeight);

  return { x: horizontal.start, y: vertical.start, width: horizontal.size, height: vertical.size };
}
