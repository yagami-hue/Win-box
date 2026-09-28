// src/main/danmaku/DanmakuStore.ts
// 弹幕显示偏好与接口清单持久化（物理文件 <userData>/danmaku.json）。
import { JsonStore } from '../store/JsonStore';
import type { Logger } from '../../shared/types';
import {
  DEFAULT_DANMAKU_SETTINGS,
  defaultDanmakuEndpoints,
  type DanmakuApiEndpoint,
  type DanmakuSettings,
} from '../../shared/danmaku';
import { endpointLabel, isBuiltinEndpoint, normalizeEndpointBase } from '../../engine/danmaku/endpoints';

/** 接口清单默认开关修订号：rev2 起默认只启用「炊烟袅袅」；旧配置读取时一次性对齐 */
export const DANMAKU_ENDPOINTS_REV = 2;

export class DanmakuStore {
  private store: JsonStore;
  private logger: Logger;
  constructor(file: string, logger: Logger) {
    this.store = new JsonStore(file);
    this.logger = logger;
  }
  get settings(): DanmakuSettings {
    const raw = this.store.getObject<Partial<DanmakuSettings> & { endpointsRev?: number }>('settings', {});
    const merged = { ...DEFAULT_DANMAKU_SETTINGS, ...raw };
    // 逐项校验（非法地址剔除、尾斜杠归一、同地址去重），避免脏数据进到请求层。
    const stored: DanmakuApiEndpoint[] = [];
    const seen = new Set<string>();
    for (const e of Array.isArray(merged.endpoints) ? merged.endpoints : []) {
      const url = normalizeEndpointBase(String(e?.url || ''));
      if (!url || seen.has(url)) continue;
      seen.add(url);
      stored.push({
        name: String(e?.name || '').trim() || endpointLabel(url),
        url,
        enabled: e?.enabled !== false,
      });
    }
    if (!stored.length) return { ...merged, endpoints: defaultDanmakuEndpoints() };
    // 旧配置（rev<2）→ 内置项开关回到默认（仅炊烟袅袅开）；用户自定义（非内置）项保留原状态
    if ((Number(raw.endpointsRev) || 1) < DANMAKU_ENDPOINTS_REV) {
      const custom = stored.filter((e) => !isBuiltinEndpoint(e.url));
      return { ...merged, endpoints: [...defaultDanmakuEndpoints(), ...custom] };
    }
    return { ...merged, endpoints: stored };
  }
  set settings(v: DanmakuSettings) {
    this.store.setObject('settings', { ...v, endpointsRev: DANMAKU_ENDPOINTS_REV });
    this.store.flush(); // 即时落盘（与其它设置存储一致，避免退出前丢开关）
  }
  update(patch: Partial<DanmakuSettings>): DanmakuSettings {
    const next = { ...this.settings, ...patch };
    this.settings = next;
    return next;
  }
}