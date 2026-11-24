import dns from 'node:dns';
import net from 'node:net';

/**
 * 校验外部打开链接的协议白名单：仅允许 http:// 与 https://，
 * 阻止 file://、ms-msdt:、javascript: 等危险或未确认的协议执行。
 */
export function validateExternalHttpUrl(rawUrl: string): string {
  const trimmed = String(rawUrl ?? '').trim();
  if (!trimmed) throw new Error('url is required');
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error('仅允许打开 http:// 或 https:// 网页链接');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('无效的 URL 地址');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('仅允许打开 http:// 或 https:// 网页链接');
  }
  return parsed.href;
}

/** 判断 IPv4 / IPv6 地址是否属于本机回环、局域网私网、链路本地或云元数据段。 */
export function isPrivateOrLocalIp(rawIp: string): boolean {
  const ip = rawIp.trim().replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  if (!ip) return true;

  // 处理 IPv4-mapped IPv6（如 ::ffff:127.0.0.1 或 ::ffff:7f00:0001）
  if (ip.startsWith('::ffff:')) {
    const tail = ip.slice('::ffff:'.length);
    if (net.isIPv4(tail)) return isPrivateOrLocalIp(tail);
    const hexMatch = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMatch) {
      const hi = parseInt(hexMatch[1], 16);
      const lo = parseInt(hexMatch[2], 16);
      const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      return isPrivateOrLocalIp(v4);
    }
  }

  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map((x) => Number(x));
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // Link-local / Cloud metadata 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true; // Multicast / Reserved
    return false;
  }

  if (net.isIPv6(ip)) {
    if (ip === '::' || ip === '::1' || ip === '0:0:0:0:0:0:0:1' || ip === '0:0:0:0:0:0:0:0') {
      return true;
    }
    if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // Unique local fc00::/7
    if (/^fe[89ab]/i.test(ip)) return true; // Link-local fe80::/10
    return false;
  }

  return false;
}

export function isPrivateOrLocalHost(rawHost: string): boolean {
  const host = rawHost.trim().replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host) return true;
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === 'metadata.google.internal'
  ) {
    return true;
  }
  if (net.isIP(host)) {
    return isPrivateOrLocalIp(host);
  }
  return false;
}

/** 校验后台抓取 URL（拦截非 http/https、本机回环、局域网私网及 DNS 重绑定到内网的地址）。 */
export async function validatePublicFetchUrl(
  rawUrl: string,
  lookupFn: typeof dns.promises.lookup = dns.promises.lookup,
): Promise<string> {
  const normalized = validateExternalHttpUrl(rawUrl);
  const parsed = new URL(normalized);
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isPrivateOrLocalHost(host)) {
    throw new Error('出于安全限制，禁止后台抓取本机或局域网内网地址');
  }
  if (!net.isIP(host)) {
    const records = await lookupFn(host, { all: true });
    if (!Array.isArray(records) || records.length === 0) {
      throw new Error(`无法解析域名：${host}`);
    }
    for (const rec of records) {
      if (isPrivateOrLocalIp(rec.address)) {
        throw new Error('出于安全限制，禁止抓取解析到本机或内网的域名');
      }
    }
  }
  return parsed.href;
}
