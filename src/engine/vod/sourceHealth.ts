// src/engine/vod/sourceHealth.ts
// ★ 逐源"有效/失效"判定 + ext 配置规则提示。纯 TS、可单测、UI 与审计共用。
// 判定以"主页真实可见内容"为准：
//   ok-content  → 主页解析到条目（无需 ext 即可见）
//   ok-classes  → 主页无条目但有分类（点分类可见内容；视为有效）
//   needs-ext   → spider(js/jar) 主页空且 ext 为空（先按家族模板补 ext 再验）
//   empty       → 有 ext 仍空 / 源返回空（多为源站失效或结构变化）
//   error       → 请求/运行抛错（网络、超时、jar 加载失败等）
export type SourceHealth = 'ok-content' | 'ok-classes' | 'needs-ext' | 'empty' | 'error';

export interface HealthInput {
  kind: 'cms-xml' | 'cms-json' | 'js' | 'jar' | 'py' | 'unsupported' | 'unknown';
  items: number;
  classes: number;
  extEmpty: boolean;
  error?: string;
}

export interface HealthOutcome {
  health: SourceHealth;
  advice: string;
  /** 该源"有效"（可正常观看主页/分类内容）与否 */
  usable: boolean;
  /** 需要人工补 ext 时为 true */
  needsExt: boolean;
}

/** ext 家族模板提示（结合 extHelper.EXT_TEMPLATES 使用） */
const FAMILY_HINT: Record<string, string> = {
  hiker: '海阔/规则类蜘蛛：在「编辑→ext」用模板「海阔(多线路 hiker)」，填入规则源地址与解析规则',
  xpath: 'XPath 规则类蜘蛛：需要在 ext 给出规则 JSON（站点+分类+详情+播放）',
  xbpq: 'XBPQ 采集模板蜘蛛：ext 应为 {siteUrl,…} 形式的采集规则',
  generic: '通用站点蜘蛛：先试模板「通用站点地址」填入 {siteUrl}；若仍空则该源在安卓同样为空（源站失效或需私有配置）',
};

export function classifyHealth(inp: HealthInput): HealthOutcome {
  if (inp.error) {
    return {
      health: 'error',
      usable: false,
      needsExt: false,
      advice: `主页加载报错：${inp.error}。请到「配置→诊断」查看是网络/接口还是蜘蛛运行时问题。`,
    };
  }
  if (inp.items > 0) {
    return { health: 'ok-content', usable: true, needsExt: false, advice: '主页可正常显示内容，无需配置 ext。' };
  }
  if (inp.classes > 0) {
    return {
      health: 'ok-classes',
      usable: true,
      needsExt: false,
      advice: '主页无推荐但有分类：点「首页分类」即可浏览内容，属有效源。',
    };
  }
  if ((inp.kind === 'js' || inp.kind === 'jar') && inp.extEmpty) {
    const hint = inp.kind === 'jar' ? FAMILY_HINT.generic : FAMILY_HINT.generic;
    return {
      health: 'needs-ext',
      usable: false,
      needsExt: true,
      advice: `蜘蛛返回空且未配置 ext。${hint} 补完后重试「体检」。`,
    };
  }
  return {
    health: 'empty',
    usable: false,
    needsExt: false,
    advice: '主页无内容：可能源站失效、接口结构变化或首页需特殊参数。用「配置→诊断」看正文与解析情况。',
  };
}
