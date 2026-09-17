// src/main/store/JsonStore.ts — 原子写 JSON 存储（防异常断电损坏）
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { KVStore } from '../../shared/types';

export class JsonStore implements KVStore {
  private data: Record<string, string> = {};
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 最近一次整文件 JSON 解析是否损坏（读时已做 .corrupt-<ts> 备份并重建为空） */
  corrupted = false;

  constructor(private file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.load();
  }

  get filePath(): string {
    return this.file;
  }

  private load(): void {
    this.corrupted = false;
    try {
      if (existsSync(this.file)) {
        const raw = readFileSync(this.file, 'utf-8');
        const parsed = JSON.parse(raw) as unknown;
        // 顶层必须是"键→字符串 JSON"对象；否则视为损坏
        if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('顶层不是 JSON 对象');
        }
        this.data = parsed as Record<string, string>;
        return;
      }
      this.data = {};
    } catch {
      // 整文件损坏：先备份为 user-config.corrupt-<ts>.json（不静默丢数据），再以空档重建
      this.data = {};
      this.corrupted = true;
      try {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        renameSync(this.file, `${this.file}.corrupt-${ts}`);
      } catch {
        // 备份失败（如文件正被占用）也吞掉，不让启动崩溃
      }
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 500);
  }

  flush(): void {
    try {
      const tmp = this.file + '.tmp';
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      renameSync(tmp, this.file); // 原子替换
    } catch {
      // ignore
    }
  }

  get(k: string): string {
    return this.data[k] ?? '';
  }
  set(k: string, v: string): void {
    this.data[k] = v;
    this.schedule();
  }
  delete(k: string): void {
    delete this.data[k];
    this.schedule();
  }

  // 业务级：JSON 对象读写
  getObject<T>(k: string, def: T): T {
    try {
      const v = this.data[k];
      return v ? (JSON.parse(v) as T) : def;
    } catch {
      return def;
    }
  }
  setObject<T>(k: string, v: T): void {
    this.data[k] = JSON.stringify(v);
    this.schedule();
  }
}

export class AppStore {
  constructor(private store: JsonStore) {}
  get config(): { apiUrl: string; configJson?: string; homeKey?: string } {
    return this.store.getObject('config', { apiUrl: '' });
  }
  set config(v: { apiUrl: string; configJson?: string; homeKey?: string }) {
    this.store.setObject('config', v);
  }
  get history(): Array<{ id: string; name: string; sourceKey: string; url: string; ts: number }> {
    return this.store.getObject('history', []);
  }
  set history(v: Array<{ id: string; name: string; sourceKey: string; url: string; ts: number }>) {
    this.store.setObject('history', v);
  }
  get favorite(): Array<{ id: string; name: string; sourceKey: string; pic: string }> {
    return this.store.getObject('favorite', []);
  }
  set favorite(v: Array<{ id: string; name: string; sourceKey: string; pic: string }>) {
    this.store.setObject('favorite', v);
  }
}
