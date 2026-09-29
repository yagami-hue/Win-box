// src/main/dlna/DlnaService.ts — DLNA 投屏的网络部分：SSDP 组播发现 + 设备描述拉取 + AVTransport 动作链。
// 纯逻辑（报文/解析）在 ./dlna.ts；本文件只碰 socket 与 HTTP。
import { createSocket } from 'node:dgram';
import { HttpClient } from '../net/HttpClient';
import type { Logger } from '../../shared/types';
import type { DlnaCastResult, DlnaCastTarget, DlnaDevice } from '../../shared/dlna';
import {
  SSDP_ADDRESS,
  SSDP_PORT,
  buildMetaData,
  buildPlayBody,
  buildSearchRequest,
  buildSeekBody,
  buildSetUriBody,
  combineUrl,
  formatMs,
  parseDeviceDescription,
  parseSsdpResponse,
  soapActionHeader,
} from './dlna';

/** 发现窗口：发 3 次 M-SEARCH，收 3 秒（与上游一致） */
const DISCOVER_MS = 3000;
const RECV_SLICE_MS = 400;

export class DlnaService {
  private http = new HttpClient();
  constructor(private logger: Logger) {}

  /** SSDP 发现局域网 MediaRenderer（去重后返回；失败只记日志，返回空列表） */
  async discover(timeoutMs = DISCOVER_MS): Promise<DlnaDevice[]> {
    const locations: string[] = [];
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    try {
      await new Promise<void>((resolve) => {
        socket.once('error', () => resolve());
        socket.bind(0, () => resolve());
      });
      try {
        socket.setMulticastTTL(4); // DLNA 惯例：不让发现包跑过本网段
      } catch {
        /* 部分环境不支持 → 忽略 */
      }
      socket.on('message', (msg) => {
        const r = parseSsdpResponse(msg.toString('utf-8'));
        if (r && !locations.includes(r.location)) locations.push(r.location);
      });
      const payload = Buffer.from(buildSearchRequest(), 'utf-8');
      for (let i = 0; i < 3; i++) {
        try {
          socket.send(payload, SSDP_PORT, SSDP_ADDRESS);
        } catch {
          /* 发送失败（无网卡/权限）→ 继续等接收 */
        }
      }
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, RECV_SLICE_MS));
      }
    } catch (e) {
      this.logger.w(`投屏: SSDP 发现失败 ${(e as Error).message}`);
    } finally {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    }

    const devices: DlnaDevice[] = [];
    for (const loc of locations) {
      const d = await this.fetchDevice(loc);
      if (d && !devices.some((x) => x.udn === d.udn)) devices.push(d);
    }
    this.logger.i(`投屏: 发现 ${locations.length} 个应答 / ${devices.length} 台可投设备`);
    return devices;
  }

  /** 拉取并解析设备描述（失败返回 null） */
  async fetchDevice(location: string): Promise<DlnaDevice | null> {
    try {
      const res = await this.http.request({ url: location, method: 'get', timeoutMs: 8000 });
      const xml = typeof res.content === 'string' ? res.content : '';
      const d = parseDeviceDescription(xml, location);
      if (!d) this.logger.w(`投屏: 设备描述无 AVTransport（跳过）：${location}`);
      return d;
    } catch (e) {
      this.logger.w(`投屏: 设备描述拉取失败 ${location} — ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * 投屏动作链（对位 `CastAsync`）：`SetAVTransportURI` 成功才 `Play`；
   * `Play` 成功且位置 > 0 才 `Seek REL_TIME`，Seek 失败只记日志、不影响「投屏成功」判定。
   */
  async cast(device: DlnaDevice, target: DlnaCastTarget): Promise<DlnaCastResult> {
    const control = combineUrl(device.location, device.controlUrl);
    const uriBody = buildSetUriBody(target.url, buildMetaData(target));
    const first = await this.post(control, 'SetAVTransportURI', uriBody);
    if (!first.ok) return { ok: false, error: `设备拒绝了播放地址：${first.error}` };
    const played = await this.post(control, 'Play', buildPlayBody());
    if (!played.ok) return { ok: false, error: `已送达但起播失败：${played.error}` };
    if (target.positionMs > 0) {
      const seek = await this.post(control, 'Seek', buildSeekBody(formatMs(target.positionMs)));
      if (!seek.ok) this.logger.w(`投屏: Seek 被忽略（继续按当前进度播）: ${seek.error}`);
    }
    this.logger.i(`投屏: 已投到「${device.name}」（${target.url.slice(0, 100)}）`);
    return { ok: true, device: device.name };
  }

  private async post(controlUrl: string, action: string, body: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await this.http.request({
        url: controlUrl,
        method: 'post',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          SOAPACTION: soapActionHeader(action),
        },
        body,
        timeoutMs: 10000,
      });
      if (res.status >= 200 && res.status < 300) return { ok: true };
      return { ok: false, error: `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
