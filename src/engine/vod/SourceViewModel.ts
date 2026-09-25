// src/engine/vod/SourceViewModel.ts
// ★ type 分发的 TS 等价（SourceViewModel.java）。home/category/detail/search/player。
// type 0/1 → CmsSource（内联，与安卓一致）；type 3 → SpiderFactory.getCSP()；
// type 2/4/-1 → 桌面版无分发实现，抛 SourceProblemError(TYPE_UNSUPPORTED) 让 UI 上屏（任务 A1）。
import type { EngineHost } from '../ports';
import type { SourceBean, VodItem, VodDetail, PlayResult } from '../../shared/types';
import { LOCAL_PROXY_BASE } from '../../shared/constants';
import { CmsSource, type CmsResult } from './CmsSource';
import { parseFilters, type SortClass } from '../parse/Movie';
import { SpiderFactory, sourceTimeoutMs, type SpiderFactoryOptions } from '../spider/SpiderFactory';
import type { Spider } from '../spider/Spider';
import { parseEpisodes } from './VodNormalizer';
import { normalizeVodId, normalizeVodPic, splitUrlHeaders } from './itemNormalize';
import { fixDetailFields } from './detailFix';
import { SourceProblemError, SOURCE_PROBLEM_TEXT } from '../spider/errors';
import { sourceAvailability, type SourceAvailability } from './sourceAvailability';

export { sourceAvailability, type SourceAvailability };

export interface HomeResult extends CmsResult {
  sourceKey: string;
}

export interface CategoryResult extends CmsResult {
  sourceKey: string;
}

export class SourceViewModel {
  private cms: CmsSource;
  private factory: SpiderFactory;

  constructor(private host: EngineHost, factoryOpt?: SpiderFactoryOptions) {
    this.cms = new CmsSource(host);
    this.factory = new SpiderFactory(factoryOpt);
  }

  get spiderFactory(): SpiderFactory {
    return this.factory;
  }

  /** 站点级 timeout（秒→ms）生效；未配置(<=0→默认)用调用方 fallback（默认 20s）。 */
  private t(bean: SourceBean, fallbackMs: number): number {
    const sec = bean?.timeout ?? 0;
    return sec > 0 ? Math.round(sec * 1000) : fallbackMs;
  }

  /** 首页 */
  async home(bean: SourceBean, timeoutMs = 20000): Promise<HomeResult> {
    const { type, api, key } = bean;
    if (type === 0 || type === 1 || type === 4) {
      const r = await this.cms.home(api, type, key, this.t(bean, timeoutMs));
      return { ...r, sourceKey: key };
    }
    if (type === 3) {
      // 对齐原版 SourceViewModel.java:230-290：homeContent 无 list 时回退 homeVideoContent
      return this.spiderHome(bean, this.t(bean, timeoutMs));
    }
    // type 2/-1：桌面版无分发实现 → 抛 TYPE_UNSUPPORTED（消息与 UI 的 sourceAvailability 一致）
    this.throwUnsupported(bean, 'home');
  }

  /** 分类列表 */
  async category(
    bean: SourceBean,
    tid: string,
    pg: string,
    extend: Record<string, string>,
    timeoutMs = 20000,
  ): Promise<CategoryResult> {
    const { type, api, key } = bean;
    if (type === 0 || type === 1 || type === 4) {
      const r = await this.cms.category(api, type, key, tid, pg, extend, this.t(bean, timeoutMs));
      return { ...r, sourceKey: key };
    }
    if (type === 3) {
      const sp = this.factory.getCSP(bean, this.host);
      const json = await Promise.resolve(sp.categoryContent(tid, pg, true, extend));
      return this.normalizeSpiderJson(json, key, false);
    }
    this.throwUnsupported(bean, 'category');
  }

  /** 详情 */
  async detail(bean: SourceBean, ids: string[], timeoutMs = 20000): Promise<VodDetail | null> {
    const { type, api, key } = bean;
    if (type === 0 || type === 1 || type === 4) {
      return this.cms.detail(api, type, key, ids, this.t(bean, timeoutMs));
    }
    if (type === 3) {
      const sp = this.factory.getCSP(bean, this.host);
      const json = await Promise.resolve(sp.detailContent(ids));
      return this.normalizeSpiderDetail(json, key);
    }
    this.throwUnsupported(bean, 'detail');
  }

  /**
   * 搜索。timeoutMs 为调用方预算（聚合搜索传更紧的值）；缺省用**源声明 timeout**，
   * 子进程蜘蛛据此设超时（死源最多占一个预算，不再 ×2，见 JarSpiderBridge 的超时语义）。
   */
  async search(bean: SourceBean, wd: string, quick = false, timeoutMs?: number): Promise<VodItem[]> {
    const { type, api, key } = bean;
    const budget = timeoutMs && timeoutMs > 0 ? timeoutMs : sourceTimeoutMs(bean);
    if (type === 0 || type === 1 || type === 4) {
      return this.cms.search(api, type, key, wd, this.t(bean, budget));
    }
    if (type === 3) {
      const sp = this.factory.getCSP(bean, this.host);
      const json = await Promise.resolve(sp.searchContent(wd, quick, budget));
      return this.normalizeSpiderSearch(json, key);
    }
    this.throwUnsupported(bean, 'search');
  }

  /** 播放：CMS 直出剧集 url；type3 走 spider.playerContent。
   *  flag 在 site.flags 或全局 flags 中 → parse=1（需解析）；否则 parse=0 直连。
   *  site.playUrl 模板（含 {playUrl} 占位）会替换 id。 */
  async play(bean: SourceBean, flag: string, id: string, vipFlags: string[], timeoutMs = 20000): Promise<PlayResult> {
    const { type, key, playUrl } = bean;
    if (type === 3) {
      const sp = this.factory.getCSP(bean, this.host);
      const json = await Promise.resolve(sp.playerContent(flag, id, vipFlags));
      return this.normalizeSpiderPlay(json, flag, playUrl);
    }
    // type 0/1/4：直连
    const url = playUrl && playUrl.includes('{playUrl}') ? playUrl.replace('{playUrl}', id) : id;
    const needParse = vipFlags.includes(flag) ? 1 : 0;
    return { parse: needParse, url, playUrl, flag };
  }

  /** 桌面版不支持的 type（2/4/-1/其它）统一抛错（辅助方法；返回 never 以闭合控制流） */
  private throwUnsupported(bean: SourceBean, method: string): never {
    const avail = sourceAvailability(bean);
    this.host.logger.w(`vm:${method} type=${bean.type} 桌面版不可用（${bean.key}）`);
    throw new SourceProblemError(
      'TYPE_UNSUPPORTED',
      avail.hint ?? SOURCE_PROBLEM_TEXT.TYPE_UNSUPPORTED,
      { sourceKey: bean.key, type: bean.type },
    );
  }

  // --- spider JSON 归一化（type3 返回的 JSON 结构 {list:[{vod_id,vod_name,vod_pic,vod_remarks}],...}） ---
  /**
   * 解析蜘蛛返回的 JSON（home/category/search 共用）。
   * 空串/纯空白 → null；非法 JSON → null；**均不抛**（是否报错交给调用方，便于首页回退）。
   */
  private parseSpiderJson(
    json: string,
    key: string,
  ): { classes: SortClass[]; items: VodItem[]; page: number; pagecount: number; total: number } | null {
    if (!json || !json.trim()) return null;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(json) as Record<string, unknown>;
    } catch {
      return null;
    }
    // 分类 id 保留原样字符串（蜘蛛源存在非数字 id，Number 化会丢分类）；type_flag 透传供筛选联动
    const classes = Array.isArray(o['class'])
      ? (o['class'] as Record<string, unknown>[]).map((c) => {
          const filters = parseFilters(c['filters']);
          return {
            id: String(c['type_id'] ?? c['id'] ?? '').trim(),
            name: String(c['type_name'] ?? c['name'] ?? '').trim(),
            flag: c['type_flag'] != null ? String(c['type_flag']) : undefined,
            // 仅当有筛选才带上 filters，保持无筛选源对象形状与历史一致
            ...(filters.length > 0 ? { filters } : {}),
          };
        })
      : [];
    const list = Array.isArray(o['list']) ? (o['list'] as Record<string, unknown>[]) : [];
    // ★ 字段名多键兜底（对齐 normalizeSpiderDetail）：部分 py 源/蜘蛛返回 `name`/`pic` 而非
    //   vod_name/vod_pic —— 缺失会让列表 name 空 → 首页 TMDB 封面补全不触发 → 长期无封面。
    const items: VodItem[] = list.map((v) => {
      const rawPic = String(
        v['vod_pic'] ??
          v['pic'] ??
          v['vod_pic_url'] ??
          v['video_pic'] ??
          (Array.isArray(v['vod_pic_thumb']) ? v['vod_pic_thumb'][0] : '') ??
          '',
      );
      const name = String(v['vod_name'] ?? v['name'] ?? '');
      return {
        // ★ 空 id → 片名兜底（片单类蜘蛛没有 vod_id；空串会让「按 id 记的坏图/补图/key」全塌到同一键）
        id: normalizeVodId(v['vod_id'] ?? v['id'], name),
        name,
        // ★ 拆上游 `@Referer=…` 尾巴（否则图床 404 → 全列表封面坏 → 补图串到所有卡片）
        pic: normalizeVodPic(rawPic),
        remarks: String(v['vod_remarks'] ?? v['remarks'] ?? ''),
        year: String(v['vod_year'] ?? v['year'] ?? ''),
        area: String(v['vod_area'] ?? v['area'] ?? ''),
        type: String(v['type_name'] ?? v['type'] ?? ''),
        sourceKey: key,
      };
    });
    return {
      classes: classes.filter((c) => c.name && c.id), // 空 name 或空 id 均丢弃（空 id 无法发起分类请求）
      items,
      page: Number(o['page'] ?? 0),
      pagecount: Number(o['pagecount'] ?? 0),
      total: Number(o['total'] ?? 0),
    };
  }

  /**
   * category/search 用：委托 parseSpiderJson。emptyIsError 语义与错误文案保持不变。
   * 空串/非法 JSON → SPIDER_ERROR；解析成功但 class+list 均空 → EMPTY_RESULT。
   */
  private normalizeSpiderJson(json: string, key: string, emptyIsError = false): HomeResult {
    const emptyResult = (): HomeResult => ({
      sortClasses: [],
      items: [],
      page: 0,
      pagecount: 0,
      total: 0,
      sourceKey: key,
    });
    const p = this.parseSpiderJson(json, key);
    if (!p) {
      if (!emptyIsError) return emptyResult();
      // 仅在 error 分支重解析一次，保留原有"非法 JSON"详情文案（正常路径无额外开销）
      if (json && json.trim()) {
        let err: unknown;
        try {
          JSON.parse(json);
        } catch (e) {
          err = e;
        }
        throw new SourceProblemError(
          'SPIDER_ERROR',
          `蜘蛛返回内容不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
          err,
        );
      }
      throw new SourceProblemError('SPIDER_ERROR', SOURCE_PROBLEM_TEXT.SPIDER_ERROR);
    }
    if (emptyIsError && p.classes.length === 0 && p.items.length === 0) {
      throw new SourceProblemError('EMPTY_RESULT', SOURCE_PROBLEM_TEXT.EMPTY_RESULT);
    }
    return {
      sortClasses: p.classes,
      items: p.items,
      page: p.page,
      pagecount: p.pagecount,
      total: p.total,
      sourceKey: key,
    };
  }

  /**
   * 首页（type3）：对齐原版 SourceViewModel.java:230-290 的「homeContent → 回退 homeVideoContent」，
   * 并补齐与 CmsSource.home 同等的「分类兜底」（见下 ③），保证 csp_/jar 源主页不出现空网格。
   * ① homeContent 自带 list → 直接用，绝不触发回退；
   * ② list 为空（或 homeContent 非法）→ 回退 homeVideoContent 取推荐列表（失败/超时静默降级，不抛）；
   * ③ 仍无条目但有分类 → 拉首个分类第 1 页当首页内容（与 CMS 路径一致，P0-JVM-HOME）；
   * ④ 兜底后仍全空 → EMPTY_RESULT（homeContent 合法）/ SPIDER_ERROR（空或非法）。
   * 注：sp.homeContent 自身抛错（.py / 无桥 jar 的 PY_UNSUPPORTED / JAR_NO_RUNTIME）必须原样上抛。
   */
  private async spiderHome(bean: SourceBean, timeoutMs: number): Promise<HomeResult> {
    const key = bean.key;
    const sp = this.factory.getCSP(bean, this.host);
    // P2-3：此预算仅约束 homeVideoContent / 分类兜底（homeContent 无独立超时，由上层 / 体检 30s race 兜底）
    const deadline = Date.now() + timeoutMs;
    const homeJson = await Promise.resolve(sp.homeContent(true)); // ★ 抛错向上传播（UnsupportedSpider 行为不变）
    const parsed = this.parseSpiderJson(homeJson, key);

    // A：homeContent 自带列表 → 直接用，绝不触发回退（不打 homeFallback 标）
    if (parsed && parsed.items.length > 0) {
      return {
        sortClasses: parsed.classes,
        items: parsed.items,
        page: parsed.page,
        pagecount: parsed.pagecount,
        total: parsed.total,
        sourceKey: key,
      };
    }

    // B/C：无 list（或 homeContent 非法）→ 回退 homeVideoContent
    const recItems = await this.tryHomeRec(sp, key, deadline);
    const classes = parsed?.classes ?? [];
    let items = recItems.length > 0 ? recItems : (parsed?.items ?? []);
    let fallbackKind: 'rec' | 'class' | '' = recItems.length > 0 ? 'rec' : '';

    // D：仍无条目但有分类 → 分类兜底（对齐 CmsSource.home:81-91；这是 JVM 源主页空白的根因修复）
    let classFallbackPage: { page: number; pagecount: number; total: number } | null = null;
    if (items.length === 0 && classes.length > 0) {
      const rec = await this.tryHomeClassRec(sp, key, classes[0].id, deadline);
      if (rec) {
        items = rec.items;
        classFallbackPage = { page: rec.page, pagecount: rec.pagecount, total: rec.total };
        fallbackKind = 'class';
      }
    }

    if (classes.length === 0 && items.length === 0) {
      // 蜘蛛端能报告具体原因时（jar 蜘蛛：源站超时/非 JSON/内部参数异常/加固壳…），
      // ★ 直接用**它**做提示文案，不再前缀「蜘蛛返回空结果（可能源站失效或需配置 ext）」。
      //
      //   历史问题：原先是 `${SPIDER_ERROR} —— 蜘蛛日志：${reason}`，于是实机日志/UI 出现
      //   「蜘蛛返回空结果（…）—— 蜘蛛日志：蜘蛛返回空结果（…）—— 蜘蛛日志：该源为安卓加固/壳…」
      //   —— 同一句话重复两遍、真正原因却排在最后，用户读不到重点。
      //   蜘蛛既然已经给出明确结论，就没有理由再叠加一句更笼统的话。
      const reason = this.spiderReason(sp);
      if (!parsed) throw new SourceProblemError('SPIDER_ERROR', reason || SOURCE_PROBLEM_TEXT.SPIDER_ERROR);
      // P2-4 已知边界差异（不修，仅记录）：class 存在但 type_name 全空（被 parseSpiderJson 过滤掉）时，
      // 此处抛 EMPTY_RESULT，而原版 SourceViewModel 返回空列表。UI 上屏更明确，属可接受差异。
      throw new SourceProblemError('EMPTY_RESULT', reason || SOURCE_PROBLEM_TEXT.EMPTY_RESULT);
    }
    return {
      sortClasses: classes,
      items,
      page: classFallbackPage?.page ?? parsed?.page ?? 0,
      pagecount: classFallbackPage?.pagecount ?? parsed?.pagecount ?? 0,
      total: classFallbackPage?.total ?? (items.length || (parsed?.total ?? 0)),
      sourceKey: key,
      // P2-3：首页内容确由回退产出 → 打标，供体检 UI 显示「首页回退」
      ...(fallbackKind ? { homeFallback: true } : {}),
    };
  }

  /** 读取蜘蛛端最近一次失败原因（仅 jar 蜘蛛有；其它实现/无线索返回空串） */
  private spiderReason(sp: Spider): string {
    try {
      const r = (sp as { lastReason?: unknown }).lastReason;
      return typeof r === 'string' ? r.trim() : '';
    } catch {
      return '';
    }
  }

  /**
   * 首页分类兜底：用首个分类的第 1 页当主页内容。
   * 场景——大量 csp_/jar 蜘蛛的 homeContent 只给 class（分类骨架），且 homeVideoContent 未实现
   * 或返回空；此时安卓原版主页是空网格。桌面版对齐 CMS 路径的兜底策略，保证"有分类即有内容"。
   * 失败/超时静默降级为 null（绝不整体报错）。
   */
  private async tryHomeClassRec(
    sp: Spider,
    key: string,
    tid: string,
    deadline: number,
  ): Promise<{ items: VodItem[]; page: number; pagecount: number; total: number } | null> {
    try {
      const remaining = Math.max(200, deadline - Date.now());
      const json = await this.withTimeout(
        Promise.resolve(sp.categoryContent(tid, '1', true, {})),
        remaining,
        'homeContent 分类兜底超时',
      );
      const p = this.parseSpiderJson(json, key);
      if (!p || p.items.length === 0) {
        this.host.logger.i(`vm:home type3 ${key} 分类兜底（tid=${tid}）无数据`);
        return null;
      }
      this.host.logger.i(`vm:home type3 ${key} 已用分类兜底（tid=${tid}）取到 ${p.items.length} 条`);
      return {
        items: p.items,
        page: p.page || 1,
        pagecount: p.pagecount || 1,
        total: p.total || p.items.length,
      };
    } catch (e) {
      this.host.logger.w(`vm:home type3 ${key} 分类兜底失败: ${(e as Error).message}`);
      return null; // ★ 兜底失败静默降级，保留分类骨架
    }
  }

  /** 回退取首页推荐：失败/超时一律静默降级为空数组（绝不整体报错） */
  private async tryHomeRec(sp: Spider, key: string, deadline: number): Promise<VodItem[]> {
    try {
      // P2-1：回退超时下限 1000ms → 200ms，避免预算耗尽时被 1s 下限拖过体检 30s race 而误判
      const remaining = Math.max(200, deadline - Date.now());
      const recJson = await this.withTimeout(
        Promise.resolve(sp.homeVideoContent()),
        remaining,
        'homeVideoContent 回退超时',
      );
      const p = this.parseSpiderJson(recJson, key);
      if (!p || p.items.length === 0) {
        this.host.logger.i(`vm:home type3 ${key} homeVideoContent 无数据`);
        return [];
      }
      this.host.logger.i(`vm:home type3 ${key} 已用 homeVideoContent 回退 ${p.items.length} 条`);
      return p.items;
    } catch (e) {
      this.host.logger.w(`vm:home type3 ${key} homeVideoContent 回退失败: ${(e as Error).message}`);
      return []; // ★ 回退失败静默降级，绝不整体报错
    }
  }

  /** Promise 超时竞速（结束即清理定时器，避免悬挂 timer 拖住事件循环 / 测试） */
  private withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(msg)), ms);
    });
    return Promise.race([p, timeout]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }

  private normalizeSpiderDetail(json: string, key: string): VodDetail | null {
    if (!json) return null;
    try {
      const o = JSON.parse(json) as Record<string, unknown>;
      const list = Array.isArray(o['list']) ? (o['list'] as Record<string, unknown>[]) : [];
      if (list.length === 0) return null;
      const v = list[0];
      const playFrom = String(v['vod_play_from'] ?? '');
      const playUrlStr = String(v['vod_play_url'] ?? '');
      const episodes: Record<string, { name: string; url: string }[]> = {};
      const flags: string[] = [];
      const flagsArr = playFrom.split('$$$');
      const urlsArr = playUrlStr.split('$$$');
      for (let i = 0; i < flagsArr.length && i < urlsArr.length; i++) {
        const f = flagsArr[i].trim();
        const eps = parseEpisodes(urlsArr[i]);
        if (f && eps.length) {
          episodes[f] = eps;
          flags.push(f);
        }
      }
      const detail: VodDetail = {
        // ★ 空 id → 片名兜底、封面拆 `@Referer=` 尾巴（同列表页归一，见 parseSpiderJson）
        id: normalizeVodId(v['vod_id'] ?? v['id'], v['vod_name'] ?? v['name']),
        name: String(v['vod_name'] ?? v['name'] ?? ''),
        pic: normalizeVodPic(
          String(
            v['vod_pic'] ??
              v['pic'] ??
              v['vod_pic_url'] ??
              v['video_pic'] ??
              (Array.isArray(v['vod_pic_thumb']) ? v['vod_pic_thumb'][0] : '') ??
              '',
          ),
        ), // ★ fty 等蜘蛛 detail 偶发把封面放在别名键，做兜底；列表页走同一归一（见 parseSpiderJson）
        type: String(v['type_name'] ?? ''),
        year: String(v['vod_year'] ?? ''),
        area: String(v['vod_area'] ?? ''),
        director: String(v['vod_director'] ?? ''),
        actor: String(v['vod_actor'] ?? ''),
        des: String(v['vod_content'] ?? ''),
        remarks: String(v['vod_remarks'] ?? ''),
        flags,
        episodes,
      };
      // ★ 2026-09-24：字段错位纠偏（如「立播」源把地区名塞进导演/演员、类型串塞进年份/地区）
      return fixDetailFields(detail);
    } catch {
      return null;
    }
  }

  private normalizeSpiderSearch(json: string, key: string): VodItem[] {
    return this.normalizeSpiderJson(json, key, false).items;
  }

  /**
   * P1-2：type3 播放结果归一化（对齐原版 Result.playContent 语义）。
   * - header/headers 备用键（蜘蛛两种拼写都常见），值统一 String 化；
   * - url 为数组（蜘蛛一次返回多段）→ 逐项归一后 # 连接，强制 parse=0 直连；
   * - video:// 前缀 → 去前缀；parse 未显式声明时才由前缀推断 parse=1（显式声明优先）；
   * - proxy://do=live... → 本地代理路由（与安卓同端口同路由）；其它 do= 原样保留 + parse=0 + 提示；
   * - jx 字段原样透传（生态里可能是 0/1，也可能是解析站 URL）；
   * - 非法 JSON / 空串 → parse=0、url=''（不抛，交给 UI 兜底）。
   */
  private normalizeSpiderPlay(json: string, flag: string, playUrl: string): PlayResult {
    const empty: PlayResult = { parse: 0, url: '', playUrl, flag };
    if (!json || !json.trim()) return empty;
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return empty;
    }
    // 数组形态：整体是 url 列表（["u1","u2"]），或 url 字段本身为数组 → # 连接直连
    const rec = parsed as Record<string, unknown> | null;
    const arr: unknown[] | null = Array.isArray(parsed)
      ? (parsed as unknown[])
      : Array.isArray(rec?.['url'])
        ? (rec['url'] as unknown[])
        : null;
    if (arr) {
      const resolvedArr = arr.map((u) => this.resolvePlayUrl(String(u ?? ''), undefined));
      const arrHdr = resolvedArr.find((r) => r.header)?.header;
      return {
        parse: 0,
        url: resolvedArr.map((r) => r.url).join('#'),
        playUrl,
        flag,
        ...(arrHdr ? { header: arrHdr } : {}),
      };
    }
    const o = (rec ?? {}) as Record<string, unknown>;
    // parse 显式声明才生效（空串/缺失均视为未声明，交由 url 前缀语义推断）
    const declared =
      o['parse'] === undefined || o['parse'] === null || o['parse'] === ''
        ? undefined
        : Number(o['parse']) || 0;
    const resolved = this.resolvePlayUrl(String(o['url'] ?? ''), declared);
    // ★ 蜘蛛显式 header 优先，其次才是地址尾巴 `@Referer=…` 拆出来的头
    const hdr = { ...(resolved.header || {}), ...(this.normalizePlayHeader(o['header'] ?? o['headers']) || {}) };
    return {
      parse: resolved.parse,
      url: resolved.url,
      playUrl,
      flag,
      ...(Object.keys(hdr).length ? { header: hdr } : {}),
      message: [String(o['msg'] ?? ''), resolved.hint].filter(Boolean).join('；') || undefined,
      jx:
        o['jx'] === undefined || o['jx'] === null || o['jx'] === ''
          ? undefined
          : (o['jx'] as number | string),
    };
  }

  /**
   * 单个播放 url 的归一：`@Referer=…` 约定尾巴 + video:// / proxy:// 前缀语义。
   * declaredParse 为蜘蛛显式 parse 声明（undefined = 未声明，由前缀推断）。
   */
  private resolvePlayUrl(
    raw: string,
    declaredParse: number | undefined,
  ): { url: string; parse: number; hint?: string; header?: Record<string, string> } {
    // ★ 上游约定：`url@Referer=…@User-Agent=…` → 拆出真实地址 + 取流所需请求头
    //   （头由 SpiderHost 经 /play 中继注入；不拆则整串当地址 → 取流必失败）
    const split = splitUrlHeaders(raw);
    const url = split.url;
    const header = Object.keys(split.headers).length
      ? {
          ...(split.headers.referer ? { Referer: split.headers.referer } : {}),
          ...(split.headers['user-agent'] ? { 'User-Agent': split.headers['user-agent'] } : {}),
          ...(split.headers.cookie ? { Cookie: split.headers.cookie } : {}),
        }
      : undefined;
    if (url.startsWith('video://')) {
      // 蜘蛛显式 parse 声明优先，仅未声明时才由前缀推断 parse=1
      return { url: url.slice('video://'.length), parse: declaredParse ?? 1, header };
    }
    if (url.startsWith('proxy://')) {
      const rest = url.slice('proxy://'.length);
      if (rest.startsWith('do=live')) {
        // 本地直播/代理资源 → 本地代理 HTTP 路由（与安卓同端口同路由 do=live）
        return { url: `${LOCAL_PROXY_BASE}/proxy?${rest}`, parse: declaredParse ?? 0, header };
      }
      // 其它 do= 路由桌面版本地代理不识别 → 原样保留 + parse=0 + message 提示
      return { url, parse: 0, hint: '该源需要蜘蛛本地代理路由（桌面版未实现）', header };
    }
    return { url, parse: declaredParse ?? 0, header };
  }

  /** header/headers 备用键 → 值统一 String 化；对象与 JSON 字符串两形态都收，其余丢弃 */
  private normalizePlayHeader(raw: unknown): Record<string, string> | undefined {
    let o: unknown = raw;
    if (typeof o === 'string') {
      try {
        o = JSON.parse(o);
      } catch {
        return undefined;
      }
    }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) out[k] = String(v);
    return Object.keys(out).length > 0 ? out : undefined;
  }
}
