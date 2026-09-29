// src/main/dlna/dlna.ts — DLNA / UPnP 投屏的**纯逻辑**（报文构造 / 应答解析 / DIDL / SOAP 外壳）。
// 逐条对位 CatClawVideo `Core/Services/Dlna.cs`（TVBox `osc/dlna` 815 行的移植）；
// 网络部分（组播、HTTP）在 DlnaService.ts —— 纯逻辑与网络分离，便于逐字节断言又不需真路由器。
import { XMLParser } from 'fast-xml-parser';
import type { DlnaCastTarget, DlnaDevice } from '../../shared/dlna';

export const SSDP_ADDRESS = '239.255.255.250';
export const SSDP_PORT = 1900;
export const RENDERER_TARGET = 'urn:schemas-upnp-org:device:MediaRenderer:1';
export const AV_TRANSPORT_TYPE = 'urn:schemas-upnp-org:service:AVTransport:1';
export const RENDERING_CONTROL_TYPE = 'urn:schemas-upnp-org:service:RenderingControl:1';

const SOAP_NS = 'http://schemas.xmlsoap.org/soap/envelope/';
const AV_TRANSPORT_NS = 'urn:schemas-upnp-org:service:AVTransport:1';

// ───────────────────────── SSDP 发现 ─────────────────────────

/** M-SEARCH 请求体（对位 Cling 的 `STAllHeader` 定向搜索） */
export function buildSearchRequest(mxSeconds = 2): string {
  return (
    'M-SEARCH * HTTP/1.1\r\n' +
    `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}\r\n` +
    'MAN: "ssdp:discover"\r\n' +
    `ST: ${RENDERER_TARGET}\r\n` +
    `MX: ${mxSeconds}\r\n` +
    '\r\n'
  );
}

/**
 * 解析一条 SSDP 应答。只认 200 且带 LOCATION 的；NOTIFY 广播（`NTS: ssdp:alive`）也吃
 * —— 很多电视主动 announce 而不回 M-SEARCH。
 */
export function parseSsdpResponse(message: string): { usn: string; location: string; st: string } | null {
  if (!message || !message.trim()) return null;
  const lines = message.replace(/\r\n/g, '\n').split('\n');
  const first = lines[0] || '';
  // 首行必须是状态行（HTTP/1.1 200 OK）或 NOTIFY —— 别把自己的 M-SEARCH 读回来
  if (!/^HTTP\//i.test(first) && !/^NOTIFY/i.test(first)) return null;
  let location = '';
  let usn = '';
  let st = '';
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim().toUpperCase();
    const val = line.slice(i + 1).trim();
    if (key === 'LOCATION') location = val;
    else if (key === 'USN') usn = val;
    else if (key === 'ST') st = val;
    else if (key === 'NT' && !st) st = val;
  }
  if (!location) return null;
  return { usn: usn || location, location, st: st || RENDERER_TARGET };
}

// ───────────────────────── 设备描述 ─────────────────────────

const descParser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  trimValues: true,
  parseTagValue: false,
  isArray: (tagName: string) => tagName === 'service',
});

function firstLocal(node: Record<string, unknown>, name: string): string {
  const v = node[name];
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v).trim();
  const t = (v as Record<string, unknown>)['#text'];
  return t == null ? '' : String(t).trim();
}

/**
 * `location` + 相对 `controlURL` → 绝对地址。
 * ⚠ UPnP 的 controlURL 一律相对**设备根**（不是 descriptor 所在目录），所以只取 scheme+authority 再拼。
 */
export function combineUrl(location: string, controlUrl: string): string {
  const c = (controlUrl || '').trim();
  if (/^https?:\/\//i.test(c)) return c;
  try {
    const loc = new URL(location);
    const root = `${loc.protocol}//${loc.host}`;
    const tail = c.startsWith('/') ? c : `/${c}`;
    return root.replace(/\/+$/, '') + tail;
  } catch {
    return c;
  }
}

/** 深度遍历（对位上游 `doc.Descendants()`：不关心 serviceList 这层壳，任意深度都能取到） */
function walk(node: unknown, visit: (o: Record<string, unknown>, key: string) => void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const v of node) walk(v, visit);
    return;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    visit(node as Record<string, unknown>, k);
    walk(v, visit);
  }
}

/** 解析设备描述 XML（无 AVTransport 的设备直接返回 null —— TVBox 同样不列出） */
export function parseDeviceDescription(xml: string, location: string): DlnaDevice | null {
  const s = (xml || '').trim();
  if (!s) return null;
  let root: Record<string, unknown>;
  try {
    root = descParser.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
  let udn = '';
  let friendly = '';
  let avt = '';
  let rc = '';
  walk(root, (o, key) => {
    if (key === 'UDN' && !udn) udn = firstLocal(o, 'UDN');
    else if (key === 'friendlyName' && !friendly) friendly = firstLocal(o, 'friendlyName');
    else if (key === 'service') {
      const svc = o['service'];
      const items = Array.isArray(svc) ? svc : svc && typeof svc === 'object' ? [svc] : [];
      for (const it of items) {
        const node = it as Record<string, unknown>;
        const type = firstLocal(node, 'serviceType');
        const ctrl = firstLocal(node, 'controlURL');
        if (!type || !ctrl) continue;
        if (!avt && type.toLowerCase() === AV_TRANSPORT_TYPE.toLowerCase()) avt = ctrl;
        if (!rc && type.toLowerCase() === RENDERING_CONTROL_TYPE.toLowerCase()) rc = ctrl;
      }
    }
  });
  if (!avt) return null;
  return {
    udn: udn || location,
    name: friendly || '未命名设备',
    controlUrl: combineUrl(location, avt),
    renderingControlUrl: rc ? combineUrl(location, rc) : undefined,
    location,
  };
}

// ───────────────────────── DIDL-Lite ─────────────────────────

/** 与 TVBox `escapeXml` 同覆盖面：5 个预定义实体 + 引号 */
export function escapeXml(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** headers → `{"K":"V",…}`（TVBox 把防盗链头序列化成 JSON 塞进 `dc:description`） */
export function headersJson(headers: Record<string, string>): string {
  const parts = Object.entries(headers).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`);
  return `{${parts.join(',')}}`;
}

/** 构造 `CurrentURIMetaData`（对位 `DLNACastManager.buildMetaData`） */
export function buildMetaData(target: DlnaCastTarget): string {
  const head =
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
    '<item id="0" parentID="-1" restricted="0">';
  const title = `<dc:title>${escapeXml(target.name)}</dc:title><dc:creator></dc:creator><upnp:class>object.item.videoItem</upnp:class>`;
  const desc =
    target.headers && Object.keys(target.headers).length
      ? `<dc:description>${escapeXml(headersJson(target.headers))}</dc:description>`
      : '';
  const res = `<res protocolInfo="http-get:*:video/*:*">${escapeXml(target.url)}</res>`;
  return `${head}${title}${desc}${res}</item></DIDL-Lite>`;
}

/** 毫秒 → UPnP 的 `H:MM:SS.mmm`（Seek REL_TIME 用） */
export function formatMs(ms: number): string {
  const v = ms > 0 ? ms : 0;
  const totalSec = Math.floor(v / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const millis = Math.floor(v % 1000);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${p2(h)}:${p2(m)}:${p2(s)}.${String(millis).padStart(3, '0')}`;
}

// ───────────────────────── SOAP ─────────────────────────

function soapBody(action: string, args: string): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    `<s:Envelope xmlns:s="${SOAP_NS}" s:encodingStyle="${SOAP_NS}-encoding">` +
    `<s:Body><u:${action} xmlns:u="${AV_TRANSPORT_NS}">${args}</u:${action}></s:Body></s:Envelope>`
  );
}

/**
 * `SetAVTransportURI` 请求体。
 * ★ DIDL 必须**再整体转义一层**（它是字符串实参，不是内联 XML）—— 漏这层是「投屏没反应」最常见的根因。
 */
export function buildSetUriBody(uri: string, didl: string): string {
  return soapBody(
    'SetAVTransportURI',
    '<InstanceID>0</InstanceID>' +
      `<CurrentURI>${escapeXml(uri)}</CurrentURI>` +
      `<CurrentURIMetaData>${escapeXml(didl)}</CurrentURIMetaData>`,
  );
}

export function buildPlayBody(): string {
  return soapBody('Play', '<InstanceID>0</InstanceID><Speed>1</Speed>');
}

export function buildStopBody(): string {
  return soapBody('Stop', '<InstanceID>0</InstanceID>');
}

export function buildSeekBody(relTime: string): string {
  return soapBody('Seek', `<InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>${relTime}</Target>`);
}

/** SOAP 1.1 要求 SOAPACTION 是**带引号**的 `#` 形式动作名 */
export function soapActionHeader(action: string): string {
  return `"${AV_TRANSPORT_NS}#${action}"`;
}
