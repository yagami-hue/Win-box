// src/main/live/EpgStore.ts — 直播 EPG（XMLTV）本地缓存：拉取 → gzip/编码归一 → 落盘 → 复用。
// 缓存规则对齐 FongMi/TV `EpgParser.refreshReason`：文件缺失 / 非当天 / 超过 6 小时 → 重新拉取。
// 磁盘落的是**解压后的 XML 文本**（上游是 gz 与 xml 两份；这里统一成一份文本，读取更简单）。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import * as iconv from 'iconv-lite';
import type { HttpClient as IHttpClient, Logger } from '../../shared/types';

const REFRESH_MS = 6 * 60 * 60 * 1000;

/** 按 XML 声明里的 encoding 解码（国内 EPG 源常见 GBK；无声明按 UTF-8） */
function decodeXml(buf: Buffer): string {
  const head = buf.subarray(0, 256).toString('latin1');
  const m = /encoding\s*=\s*["']([\w-]+)["']/i.exec(head);
  const enc = (m ? m[1] : 'utf-8').toLowerCase();
  let text: string;
  if (enc === 'gbk' || enc === 'gb2312' || enc === 'gb18030') text = iconv.decode(buf, 'gb18030');
  else if (enc === 'utf-8' || enc === 'utf8') text = buf.toString('utf-8');
  else {
    try { text = iconv.decode(buf, enc); } catch { text = buf.toString('utf-8'); }
  }
  return text.replace(/^\uFEFF/, '');
}

function isGzip(buf: Buffer): boolean {
  return buf.length > 1 && buf[0] === 0x1f && buf[1] === 0x8b;
}

function isToday(ms: number): boolean {
  const a = new Date(ms);
  const b = new Date();
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export class EpgStore {
  /** 已解析文本的内存缓存（避免每次频道切换都重读盘）；键 = URL */
  private mem = new Map<string, { at: number; text: string }>();

  constructor(private deps: { http: IHttpClient; logger: Logger; dir: string }) {}

  /** 取 XMLTV 文本（命中缓存直接回；过期/缺失才回源；回源失败则退回旧缓存） */
  async load(url: string): Promise<string> {
    const cached = this.mem.get(url);
    const now = Date.now();
    if (cached && now - cached.at < REFRESH_MS && isToday(cached.at)) return cached.text;

    const file = join(this.deps.dir, createHash('md5').update(url).digest('hex').slice(0, 16) + '.xml');
    let onDisk = existsSync(file);
    if (onDisk) {
      try {
        const mtime = statSync(file).mtimeMs;
        if (now - mtime > REFRESH_MS || !isToday(mtime)) onDisk = false;
      } catch {
        onDisk = false;
      }
    }

    if (!onDisk) {
      try {
        const res = await this.deps.http.request({ url, method: 'get', timeoutMs: 30000, buffer: 1 });
        if (res.status !== 200 || !Array.isArray(res.content)) throw new Error(`HTTP ${res.status}`);
        let buf = Buffer.from(res.content as number[]);
        if (isGzip(buf)) buf = gunzipSync(buf);
        const text = decodeXml(buf);
        try {
          if (!existsSync(this.deps.dir)) mkdirSync(this.deps.dir, { recursive: true });
          writeFileSync(file, text);
        } catch (e) {
          this.deps.logger.w(`EPG 缓存写入失败：${(e as Error).message}`);
        }
        this.mem.set(url, { at: now, text });
        this.deps.logger.i(`EPG 拉取成功：${url}（${text.length} 字符）`);
        return text;
      } catch (e) {
        this.deps.logger.w(`EPG 拉取失败：${url} — ${(e as Error).message}`);
        if (!existsSync(file)) throw e;
      }
    }

    const text = readFileSync(file, 'utf-8').replace(/^\uFEFF/, '');
    this.mem.set(url, { at: now, text });
    return text;
  }
}
