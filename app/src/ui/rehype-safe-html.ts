/**
 * 轻量 HAST HTML 消毒插件（配合 rehype-raw 使用，在 rehype-katex 之前运行）：
 * - 移除 <script> / <iframe> / <object> / <style> / <form> 等高危元素
 * - 剥离所有 on* 事件属性与 srcdoc
 * - 过滤 href / src / action 等属性中的 javascript: / vbscript: / file: 与非图片 data: URL
 * - 保留 <details>、<summary>、<sub>、<sup>、<kbd>、<mark> 及 GitHub Alert 图标等安全内容
 */

interface HastNode {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

const BLOCKED_TAGS = new Set([
  'script',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'style',
  'link',
  'meta',
  'base',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'noscript',
  'foreignobject',
  'animate',
  'animatemotion',
  'animatetransform',
  'set',
  'use',
  'math',
]);

const URL_ATTRS = new Set([
  'href',
  'src',
  'action',
  'formaction',
  'xlinkhref',
  'poster',
  'cite',
  'data',
]);

function normalizeSchemeText(raw: string): string {
  // 去掉控制字符与空白，防止 `java\nscript:` 等混淆绕过
  return raw.replace(/[\u0000-\u0020\u007f]+/g, '').toLowerCase();
}

function isSafeImageSrc(raw: string): boolean {
  const s = normalizeSchemeText(raw);
  if (!s) return false;
  if (/^data:image\/(?!svg\+xml)[a-z0-9.+-]+[;,]/i.test(s)) return true;
  if (s.startsWith('blob:') || s.startsWith('pet:')) return true;
  if (s.startsWith('//')) return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(s);
}

function isSafeGeneralUrl(raw: string): boolean {
  const s = normalizeSchemeText(raw);
  if (!s) return false;
  if (/^(?:javascript|vbscript|file):/i.test(s)) return false;
  if (s.startsWith('data:')) {
    return /^data:image\/(?!svg\+xml)[a-z0-9.+-]+[;,]/i.test(s);
  }
  return true;
}

function sanitizeProperties(tagName: string, properties: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    const lower = key.toLowerCase();
    if (lower.startsWith('on') || lower === 'srcdoc') continue;
    if (URL_ATTRS.has(lower)) {
      if (typeof value !== 'string') continue;
      const safe = tagName === 'img' && lower === 'src'
        ? isSafeImageSrc(value)
        : isSafeGeneralUrl(value);
      if (!safe) continue;
    }
    if (lower === 'style' && typeof value === 'string') {
      if (/expression\s*\(|(?:javascript|vbscript):/i.test(normalizeSchemeText(value))) {
        continue;
      }
    }
    next[key] = value;
  }
  return next;
}

function sanitizeChildren(children: HastNode[] | undefined): HastNode[] {
  if (!Array.isArray(children)) return [];
  const out: HastNode[] = [];
  for (const child of children) {
    if (!child || typeof child !== 'object') continue;
    if (child.type === 'element') {
      const tagName = String(child.tagName ?? '').toLowerCase();
      if (!tagName || BLOCKED_TAGS.has(tagName)) continue;
      out.push({
        ...child,
        tagName,
        properties: child.properties ? sanitizeProperties(tagName, child.properties) : {},
        children: sanitizeChildren(child.children),
      });
    } else {
      out.push(child);
    }
  }
  return out;
}

export function sanitizeHastTree(tree: HastNode): HastNode {
  if (!tree || typeof tree !== 'object') return tree;
  if (Array.isArray(tree.children)) {
    tree.children = sanitizeChildren(tree.children);
  }
  return tree;
}

export function rehypeSafeHtml() {
  return (tree: HastNode) => sanitizeHastTree(tree);
}
