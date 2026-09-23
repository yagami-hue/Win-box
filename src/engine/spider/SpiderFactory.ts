// src/engine/spider/SpiderFactory.ts
// ★ getCSP 二次分发（ApiConfig.java:1456）。仅处理 type=3：按 api 后缀
//   .js → JsSpider（JS 沙箱）
//   .py → UnsupportedSpider(UNSUPPORTED_PY)
//   其它 → JarSpider（jar/dex，等效 DexClassLoader：JVM 桥）—— 需配置 bridge + jar URL
// 注意：type 0/1/4 不走 getCSP（SourceViewModel 内联处理，见 CmsSource）。
import type { SourceBean } from '../../shared/types';
import type { EngineHost } from '../ports';
import { Spider, DEFAULT_SPIDER_TIMEOUT_MS, type SpiderInit } from './Spider';
import { SpiderNull } from './SpiderNull';
import { UnsupportedSpider } from './UnsupportedSpider';
import { SpiderCache } from './SpiderCache';
import { JsSpider } from '../js/JsSpider';
import { JarSpider } from './JarSpider';
import { PySpider } from './PySpider';
import type { JarSpiderBridge } from './JarSpiderBridge';

/**
 * 源级超时（ms）：配置 `timeout`（秒）> 0 则用之（clamp [5,60]s，与 SourceViewModel.t 口径一致），
 * 否则回落到 DEFAULT_SPIDER_TIMEOUT_MS。
 * ★ 同源：子进程调用超时（本文件传入 SpiderInit）与聚合搜索的单源 race 都用它 ——
 *   「源声明多久就该多久内出结果」，避免某源无限期占着 worker（历史上表现为「搜半天没结果」）。
 */
export function sourceTimeoutMs(bean: { timeout?: number } | null | undefined): number {
  const sec = Number(bean?.timeout) || 0;
  if (!(sec > 0)) return DEFAULT_SPIDER_TIMEOUT_MS;
  return Math.min(60_000, Math.max(5_000, Math.round(sec * 1000)));
}

export interface SpiderFactoryOptions {
  /** JVM 桥（jar/dex 蜘蛛运行时）。缺省则 jar 蜘蛛降级 */
  jarBridge?: JarSpiderBridge;
}

export class SpiderFactory {
  private cache = new SpiderCache();
  private bridge: JarSpiderBridge | undefined;

  constructor(opts: SpiderFactoryOptions = {}) {
    this.bridge = opts.jarBridge;
  }

  /**
   * 缓存键 = 源 key + 影响蜘蛛行为的字段签名（api/ext/jar）。
   * ★ 修复"ext 模块缺陷"：同 key 下改 ext（含网盘绑定参数）必须新建蜘蛛实例，
   *   否则蜘蛛 init(Context, ext) 一直拿旧 ext → 表现为配置了也不生效。
   */
  private keyOf(bean: SourceBean): string {
    const sig = [bean.api, bean.ext, bean.jar].map((s) => String(s || '').length + ':' + String(s || '')).join('|');
    return `${bean.key}::${sig}`;
  }

  /** 安卓 getCSP(sourceBean) 等价 —— 仅 type=3 */
  getCSP(bean: SourceBean, host: EngineHost): Spider {
    return this.cache.getOrPut(this.keyOf(bean), () => {
      const init: SpiderInit = {
        key: bean.key,
        api: bean.api,
        ext: bean.ext,
        jar: bean.jar,
        host,
        // ★ 源声明 timeout（秒，0 → 默认）→ 子进程调用超时；与聚合搜索单源超时同源，
        //   使「蜘蛛卡住」最迟在源声明时间内被 kill（此前池内固定 120s → 表现为「搜半天没结果」）
        timeoutMs: sourceTimeoutMs(bean),
      };
      const api = bean.api.toLowerCase();
      // .js —— JS 沙箱（惰性加载；脚本字节码/格式问题在首次调用时降级）
      if (api.endsWith('.js') || api.includes('.js?')) {
        return new JsSpider(init);
      }
      // .py —— 嵌入式 CPython3 宿主；无桥则降级
      if (api.includes('.py')) {
        if (this.bridge) {
          return new PySpider(init, this.bridge);
        }
        return new UnsupportedSpider(init, 'UNSUPPORTED_PY', 'python spider 需要 JVM 桥运行时（bridge 未配置）');
      }
      // jar(dex) —— JVM 桥等效 DexClassLoader（site.jar 或全局 spider jar 在运行时解析）
      if (this.bridge) {
        return new JarSpider(init, this.bridge);
      }
      return new UnsupportedSpider(init, 'UNSUPPORTED_JAR', 'jar(dex) spider 需要 JVM 桥运行时（bridge 未配置）');
    });
  }

  /** type=2 / 未知 → SpiderNull（与安卓一致：无分发分支） */
  getNull(bean: SourceBean, host: EngineHost): Spider {
    return this.cache.getOrPut(this.keyOf(bean), () => new SpiderNull({ key: bean.key, api: bean.api, ext: bean.ext, jar: bean.jar, host }));
  }

  clear(): void {
    this.cache.clear();
  }
}
