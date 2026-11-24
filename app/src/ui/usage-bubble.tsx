import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface LocalUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  lastRequestAt: number | null;
  note: string;
}
interface CodexQuota {
  ok: boolean;
  queryOk: boolean;
  planLabel: string;
  observedAt: number | null;
  stale: boolean;
  windows: Array<{ id: string; label: string; minutes: number; usedPercent: number; remainingPercent: number; resetsAt: number | null }>;
  error?: string;
}

interface Props { anchorY: number | null; visible: boolean; showUsage: boolean; speech?: string }

type Bounds = Pick<DOMRect, 'top' | 'right' | 'bottom' | 'left'>;
type Side = 'above' | 'left' | 'right' | 'below';
type Region = Bounds & { side: Side };

const BUBBLE_WIDTH = 232;
const MIN_BUBBLE_WIDTH = 140;
const EDGE_MARGIN = 12;
const MODEL_GAP = 12;
const PANEL_GAP = 8;

function visibleBounds(): Bounds {
  // Chromium reports screen and window positions in the same CSS coordinates.
  const display = window.screen as Screen & { availLeft?: number; availTop?: number };
  const screenLeft = display.availLeft ?? 0;
  const screenTop = display.availTop ?? 0;
  const left = screenLeft - window.screenX;
  const top = screenTop - window.screenY;
  return {
    left: Math.max(0, Math.ceil(left)) + EDGE_MARGIN,
    top: Math.max(0, Math.ceil(top)) + EDGE_MARGIN,
    right: Math.min(window.innerWidth, Math.floor(left + display.availWidth)) - EDGE_MARGIN,
    bottom: Math.min(window.innerHeight, Math.floor(top + display.availHeight)) - EDGE_MARGIN,
  };
}

function intersects(a: Bounds, b: Bounds): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function canFit(region: Bounds): boolean {
  return region.right - region.left >= MIN_BUBBLE_WIDTH && region.bottom > region.top;
}

/** Cut out each panel's occupied area, leaving candidate rectangles around it. */
function avoidPanel(region: Region, panel: Bounds): Region[] {
  const blocked = {
    left: Math.floor(panel.left) - PANEL_GAP,
    right: Math.ceil(panel.right) + PANEL_GAP,
    top: Math.floor(panel.top) - PANEL_GAP,
    bottom: Math.ceil(panel.bottom) + PANEL_GAP,
  };
  if (!intersects(region, blocked)) return [region];
  return [
    { ...region, right: Math.min(region.right, blocked.left) },
    { ...region, left: Math.max(region.left, blocked.right) },
    { ...region, bottom: Math.min(region.bottom, blocked.top) },
    { ...region, top: Math.max(region.top, blocked.bottom) },
  ].filter(canFit);
}

function candidateRegions(view: Bounds, model: Bounds, panels: Bounds[]): Region[] {
  const regions: Region[] = [
    { ...view, side: 'above', bottom: Math.min(view.bottom, Math.floor(model.top) - MODEL_GAP) },
    { ...view, side: 'right', left: Math.max(view.left, Math.ceil(model.right) + MODEL_GAP) },
    { ...view, side: 'left', right: Math.min(view.right, Math.floor(model.left) - MODEL_GAP) },
    { ...view, side: 'below', top: Math.max(view.top, Math.ceil(model.bottom) + MODEL_GAP) },
  ];
  const priority: Record<Side, number> = { above: 0, left: 1, right: 1, below: 2 };
  return panels.reduce(
    (available, panel) => available.flatMap((region) => avoidPanel(region, panel)),
    regions.filter(canFit),
  ).sort((a, b) => priority[a.side] - priority[b.side] || (b.right - b.left) - (a.right - a.left));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function placeBubble(
  bubble: HTMLDivElement,
  body: HTMLDivElement,
  regions: Region[],
  model: Bounds,
  sideTop: number,
): void {
  type Placement = { side: Side; left: number; top: number; width: number; bodyMaxHeight: number };
  let scrollable: Placement | undefined;
  let chosen: Placement | undefined;
  const measured = new Map<number, { height: number; chrome: number; minimum: number }>();
  for (const region of regions) {
    const width = Math.min(BUBBLE_WIDTH, region.right - region.left);
    let size = measured.get(width);
    if (!size) {
      bubble.style.width = `${width}px`;
      body.style.maxHeight = '';
      const bubbleHeight = bubble.getBoundingClientRect().height;
      const chrome = Math.ceil(bubbleHeight - body.getBoundingClientRect().height);
      // Keep the summary visible; scroll only when the expanded detail doesn't fit.
      const detailHeight = body.querySelector('.usage-bubble-detail')?.getBoundingClientRect().height ?? 0;
      size = { height: Math.ceil(bubbleHeight), chrome, minimum: Math.ceil(bubbleHeight - detailHeight) };
      measured.set(width, size);
    }
    const room = region.bottom - region.top;
    if (room < size.minimum) continue;
    const height = Math.min(size.height, room);
    const left = region.side === 'left' ? region.right - width
      : region.side === 'right' ? region.left
        : clamp(Math.round((model.left + model.right - width) / 2), region.left, region.right - width);
    const top = region.side === 'above' ? region.bottom - height
      : region.side === 'below' ? region.top
        : clamp(sideTop, region.top, region.bottom - height);
    const placement = { side: region.side, left, top, width, bodyMaxHeight: room - size.chrome };
    if (size.height <= room) {
      chosen = placement;
      break;
    }
    scrollable ??= placement;
  }
  const position = chosen ?? scrollable;
  if (!position) {
    bubble.style.visibility = 'hidden';
    return;
  }
  bubble.style.width = `${position.width}px`;
  bubble.style.left = `${position.left}px`;
  bubble.style.top = `${position.top}px`;
  bubble.dataset.side = position.side;
  body.style.maxHeight = `${position.bodyMaxHeight}px`;
  bubble.style.visibility = 'visible';
}

function formatTime(ts: number | null): string {
  if (!ts) return '暂无请求';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function formatReset(ts: number | null): string {
  if (!ts) return '未提供重置时间';
  return new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function UsageBubble({ anchorY, visible, showUsage, speech = '' }: Props): JSX.Element | null {
  const [localUsage, setUsage] = useState<LocalUsage | null>(null);
  const [codexQuota, setQuota] = useState<CodexQuota | null>(null);
  const usage = showUsage ? localUsage : null;
  const quota = showUsage ? codexQuota : null;
  const [expanded, setExpanded] = useState(false);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const bubble = bubbleRef.current;
    const body = bodyRef.current;
    if (!visible || !bubble || !body) return;
    let lastGeometry = '';
    let frame: number;
    const layout = () => {
      const host = document.querySelector('.character-host');
      const model = host?.getBoundingClientRect();
      if (!model || model.width <= 0 || model.height <= 0) {
        bubble.style.visibility = 'hidden';
        lastGeometry = '';
      } else {
        const view = visibleBounds();
        // Settings and AI panels live in portals, outside the root button menu.
        const panels = Array.from(document.querySelectorAll('.pet-menu, .pet-menu-panel'), (panel) => panel.getBoundingClientRect())
          .filter((panel) => panel.width > 0 && panel.height > 0 && intersects(panel, view));
        const geometry = [view, model, ...panels]
          .flatMap((rect) => [rect.left, rect.top, rect.right, rect.bottom].map(Math.round)).join(',');
        if (geometry !== lastGeometry) {
          lastGeometry = geometry;
          const sideOffset = host?.classList.contains('fallback-dragon') ? 12 : Math.max(12, (anchorY ?? 0) - 300);
          const sideTop = Math.round(model.top + Math.min(sideOffset, model.height / 2));
          const regions = intersects(view, model) ? candidateRegions(view, model, panels) : [];
          placeBubble(bubble, body, regions, model, sideTop);
        }
      }
      frame = window.requestAnimationFrame(layout);
    };
    // Sample moving geometry without forcing a React render every frame.
    layout();
    return () => window.cancelAnimationFrame(frame);
  }, [visible, usage, quota, speech, anchorY, expanded]);

  useEffect(() => {
    if (!showUsage) {
      setUsage(null);
      setQuota(null);
      setExpanded(false);
    }
    if (!visible || !showUsage) return;
    let cancelled = false;
    const refresh = () => window.petAPI?.usageLocal?.().then((v) => { if (!cancelled) setUsage(v); });
    const refreshQuota = () => window.petAPI?.codexQuotaRefresh?.().then((v) => { if (!cancelled) setQuota(v); });
    refresh();
    refreshQuota();
    const timer = window.setInterval(refresh, 30_000);
    const quotaTimer = window.setInterval(refreshQuota, 60_000);
    return () => { cancelled = true; window.clearInterval(timer); window.clearInterval(quotaTimer); };
  }, [visible, showUsage]);

  if (!visible || (!usage && !speech)) return null;
  const quotaWindow = quota?.ok ? quota.windows[0] : null;

  return createPortal(
    <div className="usage-bubble" ref={bubbleRef}>
      <div className="usage-bubble-body" ref={bodyRef}>
        {speech && <div className="usage-bubble-speech">{speech}</div>}
        {usage && (
          <button className="usage-bubble-toggle" type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
            <span className="usage-bubble-title">◉ {quotaWindow ? `Codex ${quota?.planLabel ?? '额度'}` : 'Codex 本地用量'}</span>
            <span className="usage-bubble-percent">{quotaWindow ? `${Math.round(quotaWindow.remainingPercent)}%` : usage.inputTokens + usage.outputTokens}</span>
            <span className="usage-bubble-unit">{quotaWindow ? `${quotaWindow.label}剩余` : '估算 Token'}</span>
            <span className="usage-bubble-caret">{expanded ? '⌃' : '⌄'}</span>
          </button>
        )}
        {expanded && usage && (
          <div className="usage-bubble-detail">
            {quota?.windows.map((w) => <div key={w.id}><span>{w.label}剩余</span><b>{Math.round(w.remainingPercent)}% · {formatReset(w.resetsAt)}</b></div>)}
            <div><span>本地请求次数</span><b>{usage.requests}</b></div>
            <div><span>本地输入 / 输出</span><b>{usage.inputTokens} / {usage.outputTokens}</b></div>
            <div><span>最近活动</span><b>{formatTime(usage.lastRequestAt)}</b></div>
            {quota && !quota.ok && <div><span>Codex 额度</span><b>暂不可用</b></div>}
            <small>{usage.note}</small>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
