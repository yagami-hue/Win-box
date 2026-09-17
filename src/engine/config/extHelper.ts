// src/engine/config/extHelper.ts
// ★ ext（站点扩展参数）助手：JSON 校验 + 常见模板 + 插入变量说明。
// 纯 TS、零 Node 依赖：renderer 直接 import（会打进 web bundle）。
// ext 是给"采集/爬虫类"源的自定义参数：type=3 蜘蛛的 init(Context,ext) 会原样收到；
// 苹果 CMS(type 0/1) 不用 ext（其"接入参数"在 api 上）；部分 csp 蜘蛛 / XPath / 海阔 / XBPQ 需要它。

export interface ExtTemplate {
  kind: string; // 模板类别
  label: string; // 展示名
  note: string; // 用途说明
  json: string; // 可直接粘贴的 ext JSON
}

/** 预置 ext 模板。站点常见形态：
 *  1) 通用站点配置 {siteUrl, siteApi,...}
 *  2) 海阔/多线路（XYQHiker）{url, list, group, rule}
 *  3) 采集站规则（XPath 系列）{规则 JSON}
 *  4) 独立资源库路径类
 *  5) 网盘登录配置（阿里云盘/夸克等）
 */
export const EXT_TEMPLATES: ExtTemplate[] = [
  {
    kind: 'basic-site',
    label: '通用站点地址',
    note: '多数 csp_/JS 蜘蛛需要知道目标站点根地址（siteUrl）与可选搜索/列表地址',
    json: JSON.stringify(
      { siteUrl: 'https://example.com', siteApi: '', siteSearch: '', sitePlay: '', ext: '', url: '' },
      null,
      2,
    ),
  },
  {
    kind: 'hiker',
    label: '海阔(多线路 hiker)',
    note: 'XYQHiker / XYQBiu / XBPQ 等"规则源"：给首页/搜索/详情/播放各自的解析规则',
    json: JSON.stringify(
      {
        url: 'https://example.com',
        list: '.video-list li',
        name: '.title',
        pic: 'img@src',
        urlKey: 'a@href',
        search: '.search-list li',
        group: '.group-list a',
        rule: { tab: '', detail: '', play: '' },
      },
      null,
      2,
    ),
  },
  {
    kind: 'csp-cms-ext',
    label: 'CMS 对接站点',
    note: '部分封装型 csp 蜘蛛要求 ext 里给出 CMS 站点 url（与 api 等价作用）',
    json: JSON.stringify({ siteUrl: 'https://cms.example.com', wd: 'keyword', flag: 'dbyun' }, null, 2),
  },
  {
    kind: 'netdisk-login',
    label: '网盘登录配置',
    note: '阿里云盘/夸克/UC/百度等网盘：在 ext 中配置 token，蜘蛛自动使用',
    json: JSON.stringify(
      {
        aliyun: 'your_refresh_token_here',
        quark: 'your_quark_token_here',
        uc: 'your_uc_token_here',
        baidu: 'your_baidu_token_here',
      },
      null,
      2,
    ),
  },
];

export interface ExtCheckResult {
  ok: boolean;
  error?: string;
  keys?: string[];
}

/** 校验 ext：空 → ok(false 且为空)；需为合法 JSON（对象或数组）；超长拒绝 */
export function validateExtJson(ext: string | null | undefined): ExtCheckResult {
  const t = (ext ?? '').trim();
  if (!t) return { ok: true, keys: [] }; // 空 ext 合法（很多源不需要）
  if (t.length > 20000) return { ok: false, error: 'ext 过长（>20K 字符），请精简或改用 jar/订阅' };
  try {
    const v = JSON.parse(t);
    if (v !== null && typeof v === 'object') {
      return { ok: true, keys: Object.keys(v as Record<string, unknown>) };
    }
    if (typeof v === 'string') return { ok: true, keys: [] };
    return { ok: false, error: 'ext 应为 JSON 对象或字符串，当前是 ' + typeof v };
  } catch (e) {
    return { ok: false, error: 'ext 不是合法 JSON：' + (e as Error).message };
  }
}

/** 快速判断 ext 是否可当作 JSON 对象用于模板覆盖（构造/替换时用） */
export function extAsObject(ext: string | null | undefined): Record<string, unknown> | null {
  const t = (ext ?? '').trim();
  if (!t) return null;
  try {
    const v = JSON.parse(t);
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* fallthrough */
  }
  return null;
}

/** 检查 ext 中是否包含网盘登录配置 */
export function hasNetdiskConfig(ext: string | null | undefined): boolean {
  const obj = extAsObject(ext);
  if (!obj) return false;
  const netdiskKeys = ['aliyun', 'quark', 'uc', 'baidu', 'pan', 'pansou'];
  return netdiskKeys.some(key => key in obj);
}

/** 从 ext 中提取网盘配置 */
export function extractNetdiskConfig(ext: string | null | undefined): Record<string, string> | null {
  const obj = extAsObject(ext);
  if (!obj) return null;
  const result: Record<string, string> = {};
  const netdiskKeys = ['aliyun', 'quark', 'uc', 'baidu', 'pan', 'pansou'];
  netdiskKeys.forEach(key => {
    if (key in obj && typeof obj[key] === 'string') {
      result[key] = obj[key];
    }
  });
  return Object.keys(result).length > 0 ? result : null;
}
