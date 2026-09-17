// src/engine/spider/UnsupportedSpider.ts
// 降级爬虫：导入时已知不支持（jar dex / py / bytecode / push），运行时把失败抛给上层。
// 任务 A1：不再静默返回空 + logOnce —— 失败必须能由上层捕获并上屏，只写日志用户看不到原因。
// 每个方法覆写抛 SourceProblemError，code 由 reason 映射（PY_UNSUPPORTED / JAR_NO_RUNTIME / ...）。
import { Spider, type SpiderInit } from './Spider';
import {
  SourceProblemError,
  sourceProblemCodeForReason,
  sourceProblemTextForReason,
} from './errors';

export class UnsupportedSpider extends Spider {
  readonly reason: string;
  readonly message: string;

  constructor(init: SpiderInit, reason: string, message: string) {
    super(init);
    this.reason = reason;
    this.message = message;
  }

  /** 统一抛错：code 由 reason 推导，message 优先用调用方传入的人读文案 */
  private unsupported(method: string): never {
    const code = sourceProblemCodeForReason(this.reason);
    const fallback = sourceProblemTextForReason(this.reason);
    throw new SourceProblemError(
      code,
      this.message || fallback || `spider:${this.siteKey} ${method} 不支持（${this.reason}）`,
    );
  }

  homeContent(_filter: boolean): never {
    return this.unsupported('homeContent');
  }
  homeVideoContent(): never {
    return this.unsupported('homeVideoContent');
  }
  categoryContent(_tid: string, _pg: string, _filter: boolean, _extend: Record<string, string>): never {
    return this.unsupported('categoryContent');
  }
  detailContent(_ids: string[]): never {
    return this.unsupported('detailContent');
  }
  searchContent(_key: string, _quick: boolean): never {
    return this.unsupported('searchContent');
  }
  searchContentPage(_key: string, _quick: boolean, _pg: string): never {
    return this.unsupported('searchContentPage');
  }
  playerContent(_flag: string, _id: string, _vipFlags: string[]): never {
    return this.unsupported('playerContent');
  }
  liveContent(_url: string): never {
    return this.unsupported('liveContent');
  }
}
