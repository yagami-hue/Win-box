// src/main/parse/ParseService.ts
// 播放地址「解析接口（parses[]）」调用链：把 parse===1 的地址换成可直连的媒体地址。
//
// 顺序（务求成功率，且避免无谓开销）：
//   ① JSON 型解析接口（type 1/2）→ HTTP 取 JSON 里的真实地址（最快，不占窗口）；
//   ② 网页解析接口（type 0）→ 隐藏窗口打开「接口地址 + 播放地址」嗅探媒体请求；
//   ③ 直接嗅探原始地址（等价于内置超级解析 type=4，也是**无 parses 时唯一的出路**）。
//
// 说明：type=4「超级解析」的内置 url 指向本机 9978（本桌面板不提供 /jiexi 页），
// 故不做 HTTP 请求，直接由 ③ 承担其语义。
import type { HttpClient, Logger, ParseBean } from '../../shared/types';
import { SUPER_PARSE_NAME, SUPER_PARSE_TYPE } from '../../shared/constants';
import { buildParseUrl, extractParseResult, isMediaUrl, parseListSummary } from './parseExtract';

export interface ParseResolution {
  url: string;
  headers: Record<string, string>;
  /** 命中途径（日志/排障用）：json:<名> / sniff:<名> / sniff:direct / already-media */
  via: string;
}

/** 嗅探实现（由主进程注入 PageSniffer，避免本模块依赖 electron → 可单测） */
export type SniffFn = (
  url: string,
  logger: Logger,
  timeoutMs: number,
) => Promise<{ url: string; headers: Record<string, string> } | null>;

/** JSON 型解析接口最多试几个（多了只会拖长时长） */
const MAX_JSON_PARSES = 4;
/** 网页型解析接口最多试几个 */
const MAX_PAGE_PARSES = 2;
/** 单个 JSON 接口超时 */
const JSON_TIMEOUT_MS = 8000;
/** 每次嗅探窗口最长等待 */
const SNIFF_TIMEOUT_MS = 12000;
/** 整个解析链总预算（超预算即放弃，让 UI 给明确提示而不是无限转圈） */
const TOTAL_BUDGET_MS = 45000;

/**
 * 还原被本地 /play 中继包装过的真实地址。
 * parse===1 的地址在 `SpiderHost.play` 里可能已按 header 包成 `…/play?url=<encoded>`，
 * 若拿这个中继地址去解析/嗅探必然失败（嗅探也会拒绝 127.0.0.1 中继）→ 先还原。
 */
export function unwrapRelayUrl(url: string): string {
  if (!/^https?:\/\/127\.0\.0\.1:9978\/play/i.test(url)) return url;
  const q = url.indexOf('?');
  if (q < 0) return url;
  try {
    const inner = new URLSearchParams(url.slice(q + 1)).get('url');
    if (inner && /^https?:\/\//i.test(inner)) return inner;
  } catch {
    /* 非法 query 原样返回 */
  }
  return url;
}

export class ParseService {
  constructor(
    private http: HttpClient,
    private logger: Logger,
    private sniff: SniffFn,
    private now: () => number = () => Date.now(),
  ) {}

  /** 解析一个需网页解析的播放地址；返回 null = 解析失败（调用方保留原始提示） */
  async resolve(parses: ParseBean[], target: string): Promise<ParseResolution | null> {
    const url = unwrapRelayUrl((target || '').trim());
    if (!url) return null;
    if (isMediaUrl(url)) return { url, headers: {}, via: 'already-media' };

    // ★ 只认 http(s) 的解析接口：R18 这类订阅里带 "Parallel"/"Sequence"（并发/轮询的编排标记，
    //   不是真实接口地址）与「超级解析」(type=4，本机内置) → 全都要排除。
    const list = (parses || []).filter(
      (p) => p && p.name !== SUPER_PARSE_NAME && p.type !== SUPER_PARSE_TYPE && /^https?:\/\//i.test(p.url || ''),
    );
    const deadline = this.now() + TOTAL_BUDGET_MS;
    const left = (): boolean => this.now() < deadline;

    // ① JSON 型解析接口
    for (const p of list.filter((x) => x.type === 1 || x.type === 2).slice(0, MAX_JSON_PARSES)) {
      if (!left()) break;
      const hit = await this.tryJsonParse(p, url);
      if (hit) return hit;
    }

    // ② 网页型解析接口（隐藏窗口嗅探解析页）
    for (const p of list.filter((x) => x.type === 0).slice(0, MAX_PAGE_PARSES)) {
      if (!left()) break;
      const page = buildParseUrl(p.url, url);
      if (!page) continue;
      const sniff = await this.sniff(page, this.logger, SNIFF_TIMEOUT_MS);
      if (sniff) return { ...sniff, via: `sniff:${p.name}` };
    }

    // ③ 直接嗅探原始地址（无 parses 的源站自播页）
    if (left()) {
      const sniff = await this.sniff(url, this.logger, SNIFF_TIMEOUT_MS);
      if (sniff) return { ...sniff, via: 'sniff:direct' };
    }

    this.logger.w(`parse: 全部解析途径失败（parses=${parseListSummary(parses)}；地址=${url.slice(0, 90)}）`);
    return null;
  }

  /** type 1/2：HTTP GET `接口地址+播放地址` 取 JSON；失败再用 form POST 试一次 */
  private async tryJsonParse(p: ParseBean, target: string): Promise<ParseResolution | null> {
    const url = buildParseUrl(p.url, target);
    if (!url) return null;
    // GET
    try {
      const res = await this.http.request({ url, method: 'get', timeoutMs: JSON_TIMEOUT_MS });
      const hit = extractParseResult(this.textOf(res.content));
      if (hit) {
        this.logger.i(`parse: ${p.name} 命中（GET）`);
        return { ...hit, via: `json:${p.name}` };
      }
    } catch (e) {
      this.logger.w(`parse: ${p.name} GET 失败 ${(e as Error).message}`);
    }
    // POST（部分接口只收 form 的 url=）
    try {
      const res = await this.http.request({
        url: p.url,
        method: 'post',
        postType: 'form',
        data: { url: target },
        timeoutMs: JSON_TIMEOUT_MS,
      });
      const hit = extractParseResult(this.textOf(res.content));
      if (hit) {
        this.logger.i(`parse: ${p.name} 命中（POST）`);
        return { ...hit, via: `json:${p.name}` };
      }
    } catch (e) {
      this.logger.w(`parse: ${p.name} POST 失败 ${(e as Error).message}`);
    }
    return null;
  }

  private textOf(content: string | number[]): string {
    return Array.isArray(content) ? Buffer.from(content).toString('utf-8') : content || '';
  }
}
