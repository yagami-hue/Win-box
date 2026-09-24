// src/engine/vod/detailFix.ts
// ★ 2026-09-24：蜘蛛详情**字段错位纠偏**（「立播」源实测）。
//   真实现象（libvio detailContent 原始返回，经 normalizeSpiderDetail 归一后）：
//     name = ''                     ← 片名缺失（列表页有，详情页丢）
//     type = '动作,惊悚,犯罪'        ← 正确（类型）
//     year = '动作,惊悚,犯罪'        ← 错位：类型串窜进了年份
//     area = '动作,惊悚,犯罪'        ← 错位：类型串窜进了地区
//     director = '韩国'  actor = '韩国' ← 错位：地区名窜进了导演/演员
//     remarks = '上映 2026-09-09(韩国)'
//   即站点信息行在蜘蛛侧被整体下移了一格。这里做**保守纠偏**：识别「地区/语言/类型串」并归位或清空；
//   清空后由详情页用 TMDb 演职员补（我们已有该能力），片名缺失由列表名兜底（渲染层传 name 参数）。
import type { VodDetail } from '../../shared/types';

const REGION_RE =
  /^(?:中国大陆|中国香港|中国台湾|中国|香港|台湾|澳门|美国|韩国|日本|英国|法国|德国|意大利|西班牙|葡萄牙|俄罗斯|乌克兰|印度|泰国|新加坡|马来西亚|越南|菲律宾|印度尼西亚|土耳其|以色列|伊朗|沙特阿拉伯|阿联酋|澳大利亚|新西兰|加拿大|巴西|墨西哥|阿根廷|智利|南非|埃及|摩洛哥|瑞典|挪威|丹麦|芬兰|冰岛|荷兰|比利时|瑞士|奥地利|波兰|捷克|匈牙利|希腊|爱尔兰|罗马尼亚|保加利亚|塞尔维亚|克罗地亚|斯洛文尼亚|斯洛伐克|立陶宛|拉脱维亚|爱沙尼亚|阿尔巴尼亚|哥伦比亚|秘鲁|委内瑞拉|古巴|巴基斯坦|孟加拉国|缅甸|柬埔寨|老挝|蒙古|哈萨克斯坦|乌兹别克斯坦|尼泊尔|斯里兰卡|其他|其它)$/;
const LANG_RE = /^(?:韩语|国语|粤语|英语|日语|法语|德语|泰语|俄语|意大利语|西班牙语|葡萄牙语|阿拉伯语|印地语|越南语|原声|双语|中字|中文字幕)$/;

/** 地区或语言名（这类值不可能是导演/演员名） */
function isRegionOrLang(s: string): boolean {
  const t = (s || '').trim();
  return !!t && (REGION_RE.test(t) || LANG_RE.test(t));
}

/** 类型串（「动作,惊悚,犯罪」这类逗号分隔的短词；用于识别窜进 year/area 的值） */
function looksLikeGenreList(s: string): boolean {
  const t = (s || '').trim();
  if (!t || t.length > 40 || !/[,，/、]/.test(t)) return false;
  const parts = t.split(/[,，/、]/).map((x) => x.trim());
  return parts.every((x) => x.length > 0 && x.length <= 6 && !REGION_RE.test(x));
}

/** 详情字段纠偏（纯函数，返回新对象；只在「明显错位」时改，正常数据原样返回） */
export function fixDetailFields(d: VodDetail): VodDetail {
  const out: VodDetail = { ...d };
  const type = (out.type || '').trim();
  const area0 = (out.area || '').trim();
  const dir0 = (out.director || '').trim();
  const act0 = (out.actor || '').trim();
  const year0 = (out.year || '').trim();

  // ① 地区错位：area 是类型串（或空），而 director/actor 位置其实是地区名 → 归位到 area
  if (!area0 || area0 === type || looksLikeGenreList(area0)) {
    const fromPeople = isRegionOrLang(dir0) ? dir0 : isRegionOrLang(act0) ? act0 : '';
    out.area = fromPeople || '';
  }
  // ② 导演/演员错位：值为地区/语言/类型串，或与 area 相同 → 视为无效清空（详情页会用 TMDb 演职员补）
  const badPerson = (s: string): boolean => !s || s === out.area || s === type || isRegionOrLang(s) || looksLikeGenreList(s);
  if (badPerson(out.director)) out.director = '';
  if (badPerson(out.actor)) out.actor = '';
  // ③ 年份错位：非 4 位数字 → 从 备注/简介/片名 里再找一次（`上映 2026-09-09(韩国)` → 2026）
  if (!/^\d{4}$/.test(year0)) {
    const m = /((?:19|20)\d{2})/.exec(`${out.remarks || ''} ${out.des || ''} ${out.name || ''}`);
    out.year = m ? m[1] : '';
  }
  return out;
}

/** 片名兜底：详情 name 为空时，用列表页带过来的名字（渲染层 query 传入） */
export function withFallbackName(d: VodDetail, fallbackName: string): VodDetail {
  const n = (fallbackName || '').trim();
  if ((d.name || '').trim() || !n) return d;
  return { ...d, name: n };
}