// tests/dlna.spec.ts
// DLNA 投屏纯逻辑单测（对位 CatClawVideo Core/Services/Dlna.cs = TVBox osc/dlna）：
// SSDP 报文/应答、设备描述解析与 controlURL 绝对化、DIDL、SOAP 报文与转义、formatMs、
// 以及「播放地址 → 投屏目标」解析。
import { describe, expect, it } from 'vitest';
import {
  AV_TRANSPORT_TYPE,
  RENDERER_TARGET,
  SSDP_ADDRESS,
  SSDP_PORT,
  buildMetaData,
  buildPlayBody,
  buildSearchRequest,
  buildSeekBody,
  buildSetUriBody,
  combineUrl,
  escapeXml,
  formatMs,
  headersJson,
  parseDeviceDescription,
  parseSsdpResponse,
  soapActionHeader,
} from '../src/main/dlna/dlna';
import { parseCastTarget } from '../src/shared/dlna';

describe('SSDP', () => {
  it('M-SEARCH 报文含 HOST/MAN/ST/MX', () => {
    const r = buildSearchRequest();
    expect(r).toContain(`HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`);
    expect(r).toContain('MAN: "ssdp:discover"');
    expect(r).toContain(`ST: ${RENDERER_TARGET}`);
    expect(r).toContain('MX: 2');
    expect(r.endsWith('\r\n\r\n')).toBe(true);
  });

  it('解析 200 应答（大小写键名）与 NOTIFY 广播', () => {
    const ok =
      'HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nLOCATION: http://192.168.1.5:49152/desc.xml\r\nUSN: uuid:abc::urn:schemas-upnp-org:device:MediaRenderer:1\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n';
    expect(parseSsdpResponse(ok)).toEqual({
      usn: 'uuid:abc::urn:schemas-upnp-org:device:MediaRenderer:1',
      location: 'http://192.168.1.5:49152/desc.xml',
      st: RENDERER_TARGET,
    });
    const notify = 'NOTIFY * HTTP/1.1\r\nNT: urn:schemas-upnp-org:device:MediaRenderer:1\r\nlocation: http://h/d.xml\r\n\r\n';
    expect(parseSsdpResponse(notify)?.location).toBe('http://h/d.xml');
  });

  it('无 LOCATION / 首行是 M-SEARCH（自己的包）/ 空 → null', () => {
    expect(parseSsdpResponse('HTTP/1.1 200 OK\r\nST: x\r\n\r\n')).toBeNull();
    expect(parseSsdpResponse('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\n\r\n')).toBeNull();
    expect(parseSsdpResponse('')).toBeNull();
  });
});

const DESC = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <friendlyName>客厅电视</friendlyName>
    <UDN>uuid:1111-2222</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
        <controlURL>/upnp/control/rc</controlURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
        <controlURL>upnp/control/avt</controlURL>
      </service>
    </serviceList>
  </device>
</root>`;

describe('设备描述', () => {
  it('解析 friendlyName/UDN/AVTransport，并补全相对 controlURL（相对**设备根**）', () => {
    const d = parseDeviceDescription(DESC, 'http://192.168.1.5:49152/desc.xml');
    expect(d).toMatchObject({
      udn: 'uuid:1111-2222',
      name: '客厅电视',
      controlUrl: 'http://192.168.1.5:49152/upnp/control/avt',
      renderingControlUrl: 'http://192.168.1.5:49152/upnp/control/rc',
    });
  });

  it('无 AVTransport 的设备不列出；非 XML/空 → null', () => {
    const noAvt = DESC.replace('AVTransport', 'ContentDirectory');
    expect(parseDeviceDescription(noAvt, 'http://h/d.xml')).toBeNull();
    expect(parseDeviceDescription('', 'http://h/d.xml')).toBeNull();
    expect(parseDeviceDescription('<rss><list/></rss>', 'http://h/d.xml')).toBeNull();
  });

  it('combineUrl：绝对地址原样、相对段挂设备根、不重复拼 scheme', () => {
    expect(combineUrl('http://h/d.xml', 'http://other/c')).toBe('http://other/c');
    expect(combineUrl('http://h:1234/desc.xml', '/upnp/control/x')).toBe('http://h:1234/upnp/control/x');
    expect(combineUrl('http://h:1234/desc.xml', 'upnp/control/x')).toBe('http://h:1234/upnp/control/x');
    expect(combineUrl('bad', 'ctrl')).toBe('ctrl');
  });
});

describe('DIDL / SOAP', () => {
  it('DIDL 含标题/类型/res，headers 序列化进 dc:description', () => {
    const didl = buildMetaData({ url: 'http://h/a.mp4', name: '第 1 集', positionMs: 0, headers: { Referer: 'http://h/' } });
    expect(didl).toContain('<dc:title>第 1 集</dc:title>');
    expect(didl).toContain('<upnp:class>object.item.videoItem</upnp:class>');
    expect(didl).toContain('http-get:*:video/*:*');
    expect(didl).toContain(escapeXml(headersJson({ Referer: 'http://h/' })));
    expect(headersJson({ A: '1' })).toBe('{"A":"1"}');
  });

  it('SetAVTransportURI 的 DIDL 与 URI 都要再转义一层', () => {
    const didl = '<DIDL-Lite><res>http://h/a.mp4?x=1&amp;y=2</res></DIDL-Lite>';
    const body = buildSetUriBody('http://h/a.mp4?x=1&y=2', didl);
    expect(body).toContain('<CurrentURI>http://h/a.mp4?x=1&amp;y=2</CurrentURI>');
    expect(body).toContain('&lt;DIDL-Lite&gt;');
    expect(body).not.toContain('<CurrentURIMetaData><DIDL-Lite>');
    expect(body).toContain(`xmlns:u="${AV_TRANSPORT_TYPE}"`);
    expect(body).toContain('<u:SetAVTransportURI');
  });

  it('Play / Seek 报文与 SOAPACTION 头（带引号 # 形式）', () => {
    expect(buildPlayBody()).toContain('<Speed>1</Speed>');
    expect(buildSeekBody('00:01:02.500')).toContain('<Unit>REL_TIME</Unit><Target>00:01:02.500</Target>');
    expect(soapActionHeader('Play')).toBe(`"${AV_TRANSPORT_TYPE}#Play"`);
  });

  it('escapeXml 覆盖 5 个实体 + 引号', () => {
    expect(escapeXml(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;');
    expect(escapeXml('')).toBe('');
  });
});

describe('formatMs', () => {
  it('毫秒 → H:MM:SS.mmm（负数归零）', () => {
    expect(formatMs(0)).toBe('00:00:00.000');
    expect(formatMs(62_500)).toBe('00:01:02.500');
    expect(formatMs(3 * 3600_000 + 61_000 + 7)).toBe('03:01:01.007');
    expect(formatMs(-5)).toBe('00:00:00.000');
  });
});

describe('parseCastTarget', () => {
  it('本机 /play 中继 → 解出真实上游 + 防盗链头', () => {
    const relay =
      'http://127.0.0.1:9978/play?url=' +
      encodeURIComponent('http://cdn.test/a.mp4') +
      '&ua=' + encodeURIComponent('Mozilla/5.0') +
      '&referer=' + encodeURIComponent('http://site.test/');
    const t = parseCastTarget(relay, '第 1 集', 12345);
    expect(t.url).toBe('http://cdn.test/a.mp4');
    expect(t.headers).toEqual({ 'User-Agent': 'Mozilla/5.0', Referer: 'http://site.test/' });
    expect(t.positionMs).toBe(12345);
    expect(t.localRelay).toBe(false);
  });

  it('外部直链原样投出去（无 headers）', () => {
    const t = parseCastTarget('https://cdn.test/b.m3u8', 'x', 0);
    expect(t).toMatchObject({ url: 'https://cdn.test/b.m3u8', positionMs: 0 });
    expect(t.headers).toBeUndefined();
    expect(t.localRelay).toBeUndefined();
  });

  it('解不出的本机中继（/bt、/proxy）标 localRelay；/play 里不是 http 也标', () => {
    expect(parseCastTarget('http://127.0.0.1:9978/bt/abc/0', 'x', 1).localRelay).toBe(true);
    expect(parseCastTarget('http://127.0.0.1:9978/proxy/4555?do=proxy&key=1', 'x', 1).localRelay).toBe(true);
    expect(parseCastTarget(`http://127.0.0.1:9978/play?url=${encodeURIComponent('/local/x.mp4')}`, 'x', 0).localRelay).toBe(true);
  });

  it('空地址 / 非法地址 / 名称缺省', () => {
    expect(parseCastTarget('', '  ', 0)).toMatchObject({ name: 'Win-Box 投屏', localRelay: true });
    expect(parseCastTarget('not a url', 'n', 0).url).toBe('not a url');
    expect(parseCastTarget('http://127.0.0.1:9978/play?url=x', '', -5).positionMs).toBe(0);
  });
});
