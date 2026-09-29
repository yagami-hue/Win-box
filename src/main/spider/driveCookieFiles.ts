// src/main/spider/driveCookieFiles.ts — 把用户绑定的网盘凭据同步为「jar 系期望的 cookie 文件」。
//
// ★ 2026-09-29 通解（对 Pizazz / 太太太硬了 系 jar 的实证，反编译自用户实际 jar）：
//   该族（sun.json；含 玩偶 csp_Wogg、木偶/快映 csp_PanWebShare、豆瓣 csp_Douban、配置 csp_Config…）
//   在 `detailContent` 组装播放列表前调用 `merge.a.a.filterCloudDiskLinks(url)`：
//     · 链接命中 pan.quark.cn  → 要求 /quark_cookie.txt 存在且内容非空，否则降级返回类型名「quark」；
//     · drive.uc.cn            → /uc_cookie.txt；
//     · pan.baidu.com          → /baidu.txt；
//     · 其余（cloud123/cloud189/aliyun/xunlei/guangya 同理）。
//   被降级 = 该条网盘链接被**丢弃**（列表里只剩类型名或整条移除）→ 用户侧现象
//   「源能进、能搜，但详情里拿不到可播资源 / 播放列表为空」。
//   文件路径 = `<externalStorage>/TVBox/<file>.txt`（jar 用 `merge.m.k.b()` 拼：外部存储 + "TVBox"）。
//   桌面桩 `android.os.Environment.getExternalStorageDirectory()` = `<java.io.tmpdir>/tvbox-ext`
//   （见 resources/jvm/stubs-src 同源构建的 stubs.jar），故实际落点 =
//     `<os.tmpdir()>/tvbox-ext/TVBox/<file>.txt`
//   内容协议（反编译实证）：`merge.b.w.r(key)` = `new JSONObject(k.a(file)).optString(key)`，
//   即 **JSON 对象、键 `cookie`**：`{"cookie":"..."}`（与安卓 TVBox 用户手放/源设置页写出的格式一致）。
//
//   与之并列的 fty 系（Cloud_*Guard）读的是 ext["Cloud-drive"] 指向的配置文件（quarkCookie/ucCookie…），
//   由 SpiderHost.syncCloudDriveConfig 负责——两者互补，缺一都会「详情/取流为空」。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** provider（DriveStore 键，小写）→ Pizazz 系 cookie 文件名（名单取自 jar 内字符串引用） */
export const PIZAZZ_COOKIE_FILES: Record<string, string> = {
  quark: 'quark_cookie.txt',
  uc: 'uc_cookie.txt',
  baidu: 'baidu.txt',
  ali: 'aliyun.txt',
  alipan: 'aliyun.txt', // 历史双键，归一化前也可能出现
};

/** Pizazz 系 cookie 目录 = 外部存储桩/TVBox（与 jar 内 `merge.m.k.b()` 拼接一致） */
export function pizazzCookieDir(tmp = tmpdir()): string {
  return join(tmp, 'tvbox-ext', 'TVBox');
}

/** 单个 provider 的 cookie 文件绝对路径；无映射返回 '' */
export function pizazzCookiePath(provider: string, tmp = tmpdir()): string {
  const file = PIZAZZ_COOKIE_FILES[String(provider || '').trim().toLowerCase()];
  return file ? join(pizazzCookieDir(tmp), file) : '';
}

/**
 * 写单个 provider 的 cookie 文件（内容 `{"cookie":"..."}`）。
 * provider 无映射或凭据为空 → 不写，返回 ''；成功返回写入路径。
 */
export function writePizazzCookieFile(provider: string, value: string, tmp = tmpdir()): string {
  const path = pizazzCookiePath(provider, tmp);
  const v = String(value || '').trim();
  if (!path || !v) return '';
  mkdirSync(pizazzCookieDir(tmp), { recursive: true });
  writeFileSync(path, JSON.stringify({ cookie: v }), 'utf-8');
  return path;
}

/**
 * 读回单个 provider 的 cookie 文件内容（用于「已有内容不重复写」判定与自检）：
 * 不存在/损坏返回 ''。
 */
export function readPizazzCookie(provider: string, tmp = tmpdir()): string {
  const path = pizazzCookiePath(provider, tmp);
  if (!path || !existsSync(path)) return '';
  try {
    const obj = JSON.parse(readFileSync(path, 'utf-8')) as { cookie?: unknown };
    return typeof obj?.cookie === 'string' ? obj.cookie : '';
  } catch {
    return '';
  }
}

/** 删除单个 provider 的 cookie 文件（解绑用；等价上游「清空该文件」语义，对 jar 侧一律视为未配置） */
export function removePizazzCookieFile(provider: string, tmp = tmpdir()): void {
  const path = pizazzCookiePath(provider, tmp);
  if (!path) return;
  rmSync(path, { force: true });
}

/**
 * 全量同步：把 tokens（DriveStore 明文列表）里所有有映射的 provider 落盘。
 * 返回实际写入的文件名列表（无变化/无映射的跳过）。
 */
export function syncPizazzCookieFiles(tokens: Record<string, string>, tmp = tmpdir()): string[] {
  const written: string[] = [];
  for (const [p, v] of Object.entries(tokens || {})) {
    if (typeof v !== 'string' || !v.trim()) continue;
    const path = writePizazzCookieFile(p, v, tmp);
    if (path) written.push(path);
  }
  return written;
}