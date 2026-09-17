// src/engine/spider/SpiderNull.ts
// 空实现（对应 Spider.java: SpiderNull extends Spider）。所有方法返回降级空值。
// 用于：type=2（无分发）、jar/py/bytecode 降级、未知源。
import { Spider, type SpiderInit } from './Spider';

export class SpiderNull extends Spider {
  constructor(init: SpiderInit) {
    super(init);
  }
}
