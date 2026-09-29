// tests/driveCookieFiles.spec.ts — 网盘凭据 → Pizazz 系 cookie 文件（2026-09-29 通解）
// 关键契约：落点 <tmp>/tvbox-ext/TVBox/<盘>.txt（= 外部存储桩/TVBox），内容 {"cookie":"..."}；
// 缺失/为空时 jar 的 filterCloudDiskLinks 会把对应网盘链接降级丢弃 → 详情播放列表为空。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PIZAZZ_COOKIE_FILES,
  pizazzCookieDir,
  pizazzCookiePath,
  writePizazzCookieFile,
  readPizazzCookie,
  removePizazzCookieFile,
  syncPizazzCookieFiles,
} from '../src/main/spider/driveCookieFiles';

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'winbox-pizazz-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('driveCookieFiles — Pizazz 系 cookie 文件同步', () => {
  it('目录与路径：<tmp>/tvbox-ext/TVBox/<file>（与 jar 外部存储桩拼接一致）', () => {
    expect(pizazzCookieDir(root)).toBe(join(root, 'tvbox-ext', 'TVBox'));
    expect(pizazzCookiePath('quark', root)).toBe(join(root, 'tvbox-ext', 'TVBox', 'quark_cookie.txt'));
    expect(pizazzCookiePath('uc', root)).toBe(join(root, 'tvbox-ext', 'TVBox', 'uc_cookie.txt'));
    expect(pizazzCookiePath('baidu', root)).toBe(join(root, 'tvbox-ext', 'TVBox', 'baidu.txt'));
    expect(pizazzCookiePath('unknown', root)).toBe(''); // 无映射
  });

  it('写入内容为 JSON {"cookie":...}（jar 侧 r(key)=JSONObject.optString(key) 实证格式）', () => {
    const ck = '__puus=PUUS1; __pus=PUS1; ck_id=abc';
    const path = writePizazzCookieFile('quark', ck, root);
    expect(path).toBe(pizazzCookiePath('quark', root));
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ cookie: ck });
    expect(readPizazzCookie('quark', root)).toBe(ck);
  });

  it('去掉首尾空白；空值与无映射 provider 不落盘', () => {
    const p = writePizazzCookieFile('baidu', '  BDUS=1  ', root);
    expect(readPizazzCookie('baidu', root)).toBe('BDUS=1');
    expect(p).toBeTruthy();
    expect(writePizazzCookieFile('baidu', '   ', root)).toBe('');
    expect(writePizazzCookieFile('115', 'X', root)).toBe(''); // 该族无 115 文件
  });

  it('alipan 历史双键归一映射到 aliyun.txt；大小写不敏感', () => {
    expect(pizazzCookiePath('ALIPAN', root)).toBe(join(root, 'tvbox-ext', 'TVBox', 'aliyun.txt'));
    expect(pizazzCookiePath('Quark', root)).toBe(join(root, 'tvbox-ext', 'TVBox', 'quark_cookie.txt'));
  });

  it('全量同步：只写有映射且有值的 provider；解绑删除文件', () => {
    const written = syncPizazzCookieFiles({ quark: 'Q1', uc: 'U1', baidu: 'B1', '115': 'NOPE' }, root);
    expect(written.map((p) => p.split(/[\\/]/).pop()).sort()).toEqual(['baidu.txt', 'quark_cookie.txt', 'uc_cookie.txt']);
    expect(Object.keys(PIZAZZ_COOKIE_FILES)).toContain('baidu');
    removePizazzCookieFile('quark', root);
    expect(existsSync(pizazzCookiePath('quark', root))).toBe(false);
    expect(readPizazzCookie('quark', root)).toBe(''); // 已删 → 视为未配置
    removePizazzCookieFile('quark', root); // 再删不抛（force）
  });

  it('损坏文件读回为空（不抛）', () => {
    const path = pizazzCookiePath('baidu', root);
    writePizazzCookieFile('baidu', 'B1', root);
    writeFileSync(path, 'not-json', 'utf-8');
    expect(readPizazzCookie('baidu', root)).toBe('');
  });
});