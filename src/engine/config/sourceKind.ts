// src/engine/config/sourceKind.ts
// ★ 源"形态"分类：把 type 与 api/jar 后缀归纳成用户能理解的四类。
//
// 上游 TVBox 的 Site 只有 type（0 xml / 1 json / 3 spider），ext 的填法完全取决于
// 蜘蛛实现（csp_Xxx 类）。桌面版为了让设置界面不把一堆无关字段摊平给用户，
// 按"这个源到底怎么跑"重新归类，只显示与该形态相关的字段。
//
// 纯 TS、零 Node 依赖：renderer / 引擎均可 import，单一事实来源。

import type { SourceBean } from '../../shared/types';

export type SourceKind = 'cms-xml' | 'cms-json' | 'spider-js' | 'spider-jar' | 'spider-py' | 'unsupported';

export interface SourceKindInfo {
  kind: SourceKind;
  /** 短标签，用于表格列与折叠标题 */
  label: string;
  /** 一句话说明这个源是怎么工作的 */
  how: string;
  /** 是否需要（且仅有它才需要）ext 配置 */
  usesExt: boolean;
  /** 是否需要 jar（独立 jar 或全局 jar） */
  usesJar: boolean;
  /** 是否需要 playUrl（站内解析地址） */
  usesPlayUrl: boolean;
}

/** 由 SourceBean 判定形态（api 后缀优先，回落到 type） */
export function sourceKindOf(s: Pick<SourceBean, 'type' | 'api'>): SourceKind {
  const low = String(s.api || '').toLowerCase().split(';')[0].trim();
  if (s.type === 0) return 'cms-xml';
  if (s.type === 1) return 'cms-json';
  if (s.type !== 3) return 'unsupported';
  if (low.endsWith('.js')) return 'spider-js';
  if (low.endsWith('.py')) return 'spider-py';
  return 'spider-jar';
}

const INFO: Record<SourceKind, SourceKindInfo> = {
  'cms-xml': {
    kind: 'cms-xml',
    label: 'CMS·XML',
    how: '苹果 CMS 的 XML 接口，直接取片，不用蜘蛛',
    usesExt: false,
    usesJar: false,
    usesPlayUrl: false,
  },
  'cms-json': {
    kind: 'cms-json',
    label: 'CMS·JSON',
    how: '苹果 CMS 的 JSON 接口，直接取片，不用蜘蛛',
    usesExt: false,
    usesJar: false,
    usesPlayUrl: false,
  },
  'spider-js': {
    kind: 'spider-js',
    label: '蜘蛛·JS',
    how: '下载 js 蜘蛛脚本在沙箱里跑，取片规则由脚本自带',
    usesExt: true,
    usesJar: false,
    usesPlayUrl: true,
  },
  'spider-jar': {
    kind: 'spider-jar',
    label: '蜘蛛·JAR',
    how: '下载 jar(dex) 在 JVM 里跑；多数需要 ext 告诉它目标站址/账号',
    usesExt: true,
    usesJar: true,
    usesPlayUrl: true,
  },
  'spider-py': {
    kind: 'spider-py',
    label: '蜘蛛·PY',
    how: 'Python 蜘蛛，经嵌入式 CPython3 运行（首次使用自动下载运行时）',
    usesExt: true,
    usesJar: false,
    usesPlayUrl: true,
  },
  unsupported: {
    kind: 'unsupported',
    label: '推送源',
    how: 'type=2/-1 的保留/推送类源，上游无内容分发，桌面版同为空',
    usesExt: false,
    usesJar: false,
    usesPlayUrl: false,
  },
};

export function sourceKindInfo(s: Pick<SourceBean, 'type' | 'api'>): SourceKindInfo {
  return INFO[sourceKindOf(s)];
}

/** 表格「形态」列用的简短文本 */
export function sourceKindLabel(s: Pick<SourceBean, 'type' | 'api'>): string {
  return INFO[sourceKindOf(s)].label;
}

/**
 * ext 的"是否需要填写"判定：只有蜘蛛类才用得上。
 * 用于设置页给出「无需 ext」而不是空文本框，减少困惑。
 */
export function extRelevant(s: Pick<SourceBean, 'type' | 'api'>): boolean {
  return INFO[sourceKindOf(s)].usesExt;
}

// ---- ★ 2026-09-29（用户报「很多源本质上是豆瓣，他们没有具体详情」）----

/**
 * 「点击片源应走**全源聚合搜索**而非详情页」的源判据（静态）。
 *
 * 依据（实测订阅里的豆瓣类源写法）：`key/name/api/ext` 任一带 `豆瓣` / `douban`。
 * 这类源是**搜索聚合型**（蜘蛛只做 searchContent，detailContent 返回空或只有简介），
 * 点进详情页必然「无详情 / 无剧集」；正确姿势是拿片名做一次全源搜索，换到能播的源。
 *
 * ★ 2026-09-30（用户报「饭太硬的豆瓣主页点了还是无详情」）：fty/饭太硬 的豆瓣片单源写成
 *   `key=点我切源 / name=豆豆┃片单 / api=csp_DouDouGuard` —— 三个字段里**都没有「豆瓣/douban」**
 *   （`豆豆`/`DouDou` 是它的自有叫法），旧判据抓不到 → 点击进详情 → 空详情。
 *   故补上 `豆豆|doudou|doudouguard` 这一族别名（摸鱼/潇洒侧则写 `csp_Douban` + 「豆瓣」名）。
 *
 * ★ 只作**点击分流**的加速判据；运行时兜底见 `detailIsEmpty()`（详情确实为空时同口径）。
 */
export function isDoubanLikeSource(
  s: Pick<SourceBean, 'key' | 'name' | 'api' | 'ext'> | null | undefined,
): boolean {
  if (!s) return false;
  const ext = typeof s.ext === 'string' ? s.ext : JSON.stringify(s.ext ?? '');
  const blob = `${s.key || ''} ${s.name || ''} ${String(s.api || '').split(';')[0]} ${ext}`.toLowerCase();
  return /豆瓣|douban|豆豆|doudou/.test(blob);
}

/** 详情结果是否「没有可播剧集」（各 flag 全空）—— 运行时兜底判据 */
export function detailIsEmpty(d: { episodes?: Record<string, unknown[]> } | null | undefined): boolean {
  if (!d || !d.episodes) return true;
  return !Object.values(d.episodes).some((list) => Array.isArray(list) && list.length > 0);
}
