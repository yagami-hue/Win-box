// src/engine/config/SiteParser.ts
// 单条 site 解析：key/type/api 必填校验、py_ 前缀强制 filterable、timeout clamp、字段默认值。
// 对齐 ApiConfig.java:752-783。
import { safeJsonInt, safeJsonString, safeJsonStringList } from '../util/json';
import type { SourceBean, SiteReportItem, SiteStatus, SiteReason } from '../../shared/types';
import {
  DEFAULT_SEARCHABLE,
  DEFAULT_QUICK_SEARCH,
  DEFAULT_CHANGEABLE,
  DEFAULT_FILTERABLE,
  DEFAULT_PLAYER_TYPE,
  SITE_TIMEOUT_DEFAULT,
  SITE_TIMEOUT_MIN,
  SITE_TIMEOUT_MAX,
} from '../../shared/constants';

export interface SiteParseResult {
  bean: SourceBean | null;
  report: SiteReportItem;
}

function clampTimeout(v: number): number {
  if (v <= 0) return SITE_TIMEOUT_DEFAULT;
  if (v < SITE_TIMEOUT_MIN) return SITE_TIMEOUT_MIN;
  if (v > SITE_TIMEOUT_MAX) return SITE_TIMEOUT_MAX;
  return v;
}

/** 解析单条 site。缺 key/type/api → SKIP。type=2 或未知 → SKIP(UNKNOWN_TYPE)。 */
export function parseSite(obj: unknown, index: number): SiteParseResult {
  const o = (obj ?? {}) as Record<string, unknown>;
  const reportBase = { index, key: '', name: '', type: 0, api: '' };
  // 必填校验（ApiConfig.java:755）—— 任一缺失整条跳过
  const hasKey = 'key' in o && o.key != null && String(o.key).trim().length > 0;
  const hasType = 'type' in o && o.type != null;
  const hasApi = 'api' in o && o.api != null && String(o.api).trim().length > 0;

  let status: SiteStatus = 'OK';
  let reason: SiteReason | undefined;

  if (!hasKey || !hasType || !hasApi) {
    status = 'SKIP';
    reason = !hasKey ? 'MISSING_KEY' : !hasType ? 'MISSING_TYPE' : 'MISSING_API';
    // 仍尽量读出 key/name/type 供诊断
    const key = hasKey ? String(o.key).trim() : '';
    const api = hasApi ? String(o.api).trim() : '';
    return {
      bean: null,
      report: {
        ...reportBase,
        key,
        name: key,
        type: hasType ? safeJsonInt(o, 'type', 0) : 0,
        api,
        status,
        reason,
        message: `跳过：缺少必填字段 (${reason})`,
      },
    };
  }

  const key = String(o.key).trim();
  const name = safeJsonString(o, 'name', key);
  const type = safeJsonInt(o, 'type', 0);
  const api = safeJsonString(o, 'api', '').trim();

  // type=2 安卓无任何分发分支（历史保留值），与安卓一致跳过
  if (type === 2) {
    status = 'SKIP';
    reason = 'UNKNOWN_TYPE';
  }

  const pyPrefix = key.startsWith('py_');
  const filterable = pyPrefix ? 1 : safeJsonInt(o, 'filterable', DEFAULT_FILTERABLE);
  const jar = safeJsonString(o, 'jar', '');

  // v1 降级判定（不影响 bean 落地，只影响诊断与后续 SpiderFactory）：
  // - type=-1 推送源 → UNSUPPORTED_PUSH（DEGRADE）
  // - type=3 + .py → OK（桌面端已内嵌嵌入式 CPython 运行时，见 .py 源运行时改造；
  //   与安卓 normal flavor 不同，这里不再降级）
  if (status === 'OK' && type === -1) {
    status = 'DEGRADE';
    reason = 'UNSUPPORTED_PUSH';
  }

  const bean: SourceBean = {
    key,
    name,
    type,
    api,
    searchable: safeJsonInt(o, 'searchable', DEFAULT_SEARCHABLE),
    quickSearch: safeJsonInt(o, 'quickSearch', DEFAULT_QUICK_SEARCH),
    changeable: safeJsonInt(o, 'changeable', DEFAULT_CHANGEABLE),
    filterable,
    playUrl: safeJsonString(o, 'playUrl', ''),
    ext: safeJsonString(o, 'ext', ''),
    jar,
    playerType: safeJsonInt(o, 'playerType', DEFAULT_PLAYER_TYPE),
    categories: safeJsonStringList(o, 'categories'),
    timeout: clampTimeout(safeJsonInt(o, 'timeout', 0)),
    click: safeJsonString(o, 'click', ''),
    style: safeJsonString(o, 'style', ''),
  };

  const message =
    status === 'OK'
      ? '已导入'
      : status === 'DEGRADE'
        ? `降级：${reason}（已导入；点击使用时页面会给出具体不可用原因）`
        : `跳过：${reason}`;

  return {
    bean,
    report: {
      index,
      key,
      name,
      type,
      api,
      status,
      reason,
      message,
    },
  };
}
