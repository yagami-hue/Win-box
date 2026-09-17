// src/engine/js/globals/index.ts
// 汇总注入 node:vm 沙箱的全部全局 API（对齐安卓 QuickJS createCtx + Global 绑定，
// 见 ref/.../js__JsSpider.java createCtx / ref/.../js__Global.java）。
// 说明：
//   - net.js（resources/js-lib/net.js）不 eval 源文件 —— 其 let 声明在 node:vm 里不会挂到
//     globalThis，改为直接注入等价的 { req, http } 全局（SandboxHttp.createHttpGlobals）。
//   - cheerio / CryptoJS 同时注入为全局与 $.require 可取（蜘蛛两种写法都常见）。
//   - 模板.js / gbk.js / similarity.js / cat.js / utils.js 的加载由 JsSandbox.loadLib 提供。
//     utils.js 已由自研可执行子集覆盖（原 QuickJS 字节码不可执行），走正常模块加载。
import type { EngineHost } from '../../ports';
import * as cheerio from 'cheerio';
import * as CryptoJS from 'crypto-js';
import { createHttpGlobals } from './SandboxHttp';
import { createLocal } from './SandboxLocal';
import { aesX, rsaX, rsaEncrypt, rsaDecrypt } from './SandboxCrypto';
import { createConsole, createTimers, createProxyFns, createTransStub } from './SandboxMisc';
import { joinUrl, parseDomForArray, parseDomForList, parseDomForUrl } from './HtmlParser';

/**
 * 构造沙箱全局对象（返回值整体传给 vm.createContext）。
 * @param host      引擎宿主（http/kv/logger/proxyBase/httpSync）
 * @param siteKey   站点 key（日志前缀 / local 键不再需要，local 用宿主 kv）
 * @param loadLib   $.require(name) 的实现，由 JsSandbox 提供（模块加载管线）
 */
export function buildSandboxGlobals(
  host: EngineHost,
  siteKey: string,
  loadLib: (name: string) => unknown,
): Record<string, unknown> {
  return {
    // --- 网络（net.js 语义：req 同步 / http 返回 Promise） ---
    ...createHttpGlobals(host, siteKey),
    // --- 海阔规则 DSL（Global.java:54-81） ---
    pdfh: (html: string, rule: string): string => parseDomForUrl(html, rule, ''),
    pd: (html: string, rule: string, addUrl: string): string => parseDomForUrl(html, rule, addUrl ?? ''),
    pdfa: (html: string, rule: string): string[] => parseDomForArray(html, rule),
    pdfla: (html: string, p1: string, listText: string, listUrl: string, addUrl: string): string[] =>
      parseDomForList(html, p1, listText, listUrl, addUrl ?? ''),
    joinUrl,
    // --- 本地存储（local.java） ---
    local: createLocal(host),
    // --- 加解密（Crypto.java / Global.java） ---
    aesX,
    rsaX,
    rsaEncrypt,
    rsaDecrypt,
    // --- 杂项 ---
    console: createConsole(host, siteKey),
    ...createTimers(),
    ...createProxyFns(host),
    // 繁简转换 v1 恒等 stub（词典未移植）
    ...createTransStub(),
    // --- 模块加载（QuickJS 的 $.require 等价） ---
    $: { require: loadLib },
    // --- 常用库直挂全局（蜘蛛常不经 require 直接用） ---
    cheerio,
    CryptoJS,
  };
}
