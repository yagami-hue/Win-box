// src/engine/spider/SpiderCache.ts
// key → Spider 缓存（对应 JsLoader.spiders）。同源复用，避免重复初始化。
import type { Spider } from './Spider';

export class SpiderCache {
  private map = new Map<string, Spider>();

  get(key: string): Spider | undefined {
    return this.map.get(key);
  }

  set(key: string, spider: Spider): void {
    this.map.set(key, spider);
  }

  getOrPut(key: string, factory: () => Spider): Spider {
    let s = this.map.get(key);
    if (!s) {
      s = factory();
      this.map.set(key, s);
    }
    return s;
  }

  clear(): void {
    this.map.clear();
  }
}
