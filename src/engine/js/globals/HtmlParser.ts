// src/engine/js/globals/HtmlParser.ts
// ★ 海阔规则 DSL 的 cheerio 实现 —— 1:1 对齐
//   ref/app__src__main__java__com__github__catvod__crawler__js__HtmlParser.java
// 对外入口（与 Global.java 绑定一致）：
//   pdfh(html, rule)                 = parseDomForUrl(html, rule, '')
//   pd(html, rule, add_url)          = parseDomForUrl(html, rule, add_url)
//   pdfa(html, rule)                 = parseDomForArray(html, rule) → string[]（每项 outerHtml）
//   pdfla(html, p1, text, url, add)  = parseDomForList(...)          → string[]（每项 text$url）
//   joinUrl(parent, child)
//
// ★ cheerio 与 Jsoup 的关键差异（都已手动弥合）：
//   1) cheerio/css-select 不支持 :eq/:lt/:gt/:first/:last 伪类 —— 选择器里先剥掉，
//      索引效果用 .eq()/.slice() 手动应用（Java 对 :eq 也是手动处理，思路一致；
//      :lt/:gt/:first/:last 在 Java 是 Jsoup 原生支持，这里补齐语义）。
//   2) Java 用静态字段缓存 pdfh_doc/pdfa_doc；v1 简化为每次调用重新 parse
//      （不同蜘蛛并发共享静态缓存反而有隔离风险；性能瓶颈通常在网络而非 parse）。
//   3) Elements.html()（多元素合并 inner html）在 cheerio 里等价取第一个的 inner html ——
//      pdfh 路径已先 eq(0) 归一，实际无差异。
import * as cheerio from 'cheerio';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sel = cheerio.Cheerio<any>; // cheerio 泛型节点类型跨 domhandler 版本不稳，这里用 any 承接

/** 不自动补 :eq(0) 的 token（HtmlParser.java:21 NOADD_INDEX） */
const NOADD_INDEX = /:eq|:lt|:gt|:first|:last|^body$|^#/;
/** 需要自动 urljoin 的属性名（HtmlParser.java:22 URLJOIN_ATTR） */
const URLJOIN_ATTR = /(url|src|href|-original|-src|-play|-url|style)$/i;
/** 过滤特殊链接，不走 urlJoin（HtmlParser.java:23 SPECIAL_URL） */
const SPECIAL_URL = /^(ftp|magnet|thunder|ws):/i;

/** 单段规则解析结果（对齐 HtmlParser.Painfo） */
interface Painfo {
  rule: string;
  index: number;
  excludes: string[];
  /** Jsoup 原生支持而 cheerio 不支持的索引伪类，剥离后手动应用 */
  first: boolean;
  last: boolean;
  lt: number | null;
  gt: number | null;
}

/** getParseInfo（HtmlParser.java:52-91）—— 1:1，含 '--' 排除与 :eq 索引解析 */
function getParseInfo(nparse: string): Painfo {
  const info: Painfo = { rule: nparse, index: 0, excludes: [], first: false, last: false, lt: null, gt: null };
  if (nparse.includes(':eq')) {
    info.rule = nparse.split(':')[0];
    let pos = nparse.split(':')[1] ?? '';
    if (info.rule.includes('--')) {
      const rules = info.rule.split('--');
      info.excludes = rules.slice(1);
      info.rule = rules[0];
    } else if (pos.includes('--')) {
      const rules = pos.split('--');
      info.excludes = rules.slice(1);
      pos = rules[0];
    }
    // Java: Integer.parseInt(pos.replace("eq(", "").replace(")", ""))，失败 → 0
    const m = /eq\(\s*(-?\d+)\s*\)/.exec(pos);
    info.index = m ? parseInt(m[1], 10) : 0;
  } else {
    if (nparse.includes('--')) {
      const rules = info.rule.split('--');
      info.excludes = rules.slice(1);
      info.rule = rules[0];
    }
    // :lt/:gt/:first/:last —— Jsoup 原生支持，cheerio 不支持：剥离并记录
    const fm = /:first(?![\w-])/.exec(info.rule);
    if (fm) { info.first = true; }
    const lm = /:last(?![\w-])/.exec(info.rule);
    if (lm) { info.last = true; }
    const lt = /:lt\((\d+)\)/.exec(info.rule);
    if (lt) { info.lt = parseInt(lt[1], 10); }
    const gt = /:gt\((\d+)\)/.exec(info.rule);
    if (gt) { info.gt = parseInt(gt[1], 10); }
    info.rule = info.rule
      .replace(/:(?:first|last)(?![\w-])/g, '')
      .replace(/:lt\(\d+\)/g, '')
      .replace(/:gt\(\d+\)/g, '');
  }
  return info;
}

/** parseHikerToJq（HtmlParser.java:120-157）—— 1:1。
 * 海阔表达式转 jq 表达式并自动补 :eq(0)：first=true（pdfh/pd）全段补；
 * first=false（pdfa/pdfla）时最后一段不补。 */
function parseHikerToJq(parse: string, first: boolean): string {
  if (parse.includes('&&')) {
    const parses = parse.split('&&');
    const newParses: string[] = [];
    for (let i = 0; i < parses.length; i++) {
      const pss = parses[i].split(' ');
      const ps = pss[pss.length - 1]; // 分割 && 后带空格就取最后一个 token
      if (!NOADD_INDEX.test(ps)) {
        if (!first && i >= parses.length - 1) newParses.push(parses[i]); // 最后一段不补
        else newParses.push(`${parses[i]}:eq(0)`);
      } else {
        newParses.push(parses[i]);
      }
    }
    return newParses.join(' ');
  }
  const pss = parse.split(' ');
  const ps = pss[pss.length - 1];
  if (!NOADD_INDEX.test(ps) && first) return `${parse}:eq(0)`;
  return parse;
}

/** parseOneRule（HtmlParser.java:250-274）—— 1:1。
 * doc 为 null 时按文档根选择，否则在上一轮结果集内查找（对应 Jsoup Elements.select）。 */
function parseOneRule($: cheerio.CheerioAPI, nparse: string, prev: Sel | null): Sel {
  const info = getParseInfo(nparse);
  let ret: Sel;
  const rule = info.rule.trim();
  if (!prev || prev.length === 0) {
    ret = rule ? $(rule) : $([]);
  } else {
    ret = rule ? prev.find(rule) : $([]);
  }

  if (nparse.includes(':eq')) {
    // Java: index<0 → ret.eq(size+index)；cheerio .eq 越界返回空集合，与 Jsoup 一致
    const size = ret.length;
    ret = ret.eq(info.index < 0 ? size + info.index : info.index);
  }
  // Jsoup 原生伪类的手动补齐（仅无 :eq 时可能出现，见 getParseInfo）
  if (info.first) ret = ret.eq(0);
  else if (info.last) ret = ret.eq(-1);
  if (info.lt !== null) ret = ret.slice(0, info.lt);
  if (info.gt !== null) ret = ret.slice(info.gt + 1);

  if (info.excludes.length > 0 && ret.length > 0) {
    // Java: ret.clone() 后 find(exclude).remove()，避免污染文档；cheerio 同思路
    const clone = ret.clone();
    for (const ex of info.excludes) {
      if (ex) clone.find(ex).remove();
    }
    ret = clone;
  }
  return ret;
}

/** 在规则链上逐段 select；任何一段选空 → 返回 null（调用方返回空结果） */
function selectChain($: cheerio.CheerioAPI, rule: string, first: boolean): Sel | null {
  const jq = parseHikerToJq(rule, first);
  let ret: Sel | null = null;
  for (const seg of jq.split(' ')) {
    if (!seg) continue;
    ret = parseOneRule($, seg, ret);
    if (!ret || ret.length === 0) return null;
  }
  return ret;
}

/** joinUrl（HtmlParser.java:27-44）—— new URL(child, parent)，失败返回 child */
export function joinUrl(parent: string, child: string): string {
  if (!parent) return child;
  try {
    return new URL(child, parent).toString();
  } catch {
    return child;
  }
}

/** parseDomForUrl（HtmlParser.java:159-224）—— 1:1 */
export function parseDomForUrl(html: string, rule: string, addUrl: string): string {
  if (!html || !rule) return '';
  const $ = cheerio.load(html);
  // 全文捷径（Java:165-169）
  if (rule === 'body&&Text' || rule === 'Text') return $('body').text();
  if (rule === 'body&&Html' || rule === 'Html') return $.html();

  let option = '';
  if (rule.includes('&&')) {
    const rs = rule.split('&&');
    option = rs[rs.length - 1];
    rule = rs.slice(0, -1).join('&&');
  }
  const ret = selectChain($, rule, true);
  if (!ret || ret.length === 0) return '';

  let result = '';
  if (option) {
    if (option === 'Text') {
      result = ret.text();
    } else if (option === 'Html') {
      result = ret.html() ?? '';
    } else {
      result = ret.attr(option) ?? '';
      // style 属性含 url(...) → 提取 url 并去引号（Java:195-204）
      if (option.toLowerCase().includes('style') && result.includes('url(')) {
        const m = /url\((.*?)\)/s.exec(result);
        if (m) result = m[1];
        if (result) result = result.replace(/^['"](.*)['"]$/, '$1');
      }
      if (result && addUrl) {
        // 需要自动 urljoin 的属性 + 非特殊协议（Java:205-217）
        if (URLJOIN_ATTR.test(option) && !SPECIAL_URL.test(result)) {
          if (result.includes('http')) result = result.substring(result.indexOf('http'));
          else result = joinUrl(addUrl, result);
        }
      }
    }
  } else {
    // 无 option → 第一个元素的 outerHtml（Java:220）
    result = ret.length > 0 ? $.html(ret[0]) : '';
  }
  return result;
}

/** parseDomForArray（HtmlParser.java:226-248）—— 1:1；每项 outerHtml */
export function parseDomForArray(html: string, rule: string): string[] {
  if (!html || !rule) return [];
  const $ = cheerio.load(html);
  const ret = selectChain($, rule, false);
  if (!ret || ret.length === 0) return [];
  return ret.toArray().map((el) => $.html(el));
}

/** parseDomForList（HtmlParser.java:276-299）—— 1:1；每项 `text$url` */
export function parseDomForList(html: string, p1: string, listText: string, listUrl: string, addUrl: string): string[] {
  if (!html || !p1) return [];
  const $ = cheerio.load(html);
  const ret = selectChain($, p1, false);
  if (!ret || ret.length === 0) return [];
  const out: string[] = [];
  for (const el of ret.toArray()) {
    const it = $.html(el);
    out.push(`${parseDomForUrl(it, listText, '').trim()}$${parseDomForUrl(it, listUrl, addUrl)}`);
  }
  return out;
}
