// src/main/net/DnsResolver.ts — DoH（DNS-over-HTTPS）解析 + 带 DoH 的 undici Agent 工厂
// 用途：TMDB 等海外 API 在本机常被 DNS 污染（api.themoviedb.org 直连解析失败）。
//       本模块用 DoH 拿真实 A 记录，再经 Agent.connect.lookup 直连；DoH 全部失败回退系统 DNS。
// 实测（2026-09-18）：api.themoviedb.org 经 doh.pub 解析后可达（401=仅缺 key），直连被污染（000）。
import { request as undiciRequest } from 'undici';
import { lookup as dnsLookup } from 'node:dns';
import { Agent } from 'undici';

/** DoH 服务器（DNS-over-HTTPS JSON 格式），按序尝试：腾讯 doh.pub → dnspod → 阿里 */
const DOH_SERVERS: string[] = [
  'https://doh.pub/dns-query',
  'https://1.12.12.12/dns-query',
  'https://223.5.5.5/dns-query',
];

type LookupCallback = (err: Error | null, address?: string, family?: number) => void;

/** 提取 DoH 应答里的 A 记录（跳过 127.x：CDN 已下线的死域常被解析到回环，直连必 ECONNREFUSED） */
async function dohResolve(host: string, servers: string[]): Promise<string[]> {
  let lastErr: unknown = null;
  for (const base of servers) {
    try {
      const u = `${base}?name=${encodeURIComponent(host)}&type=A`;
      const r = await undiciRequest(u, {
        method: 'GET',
        headers: { accept: 'application/dns-json' },
        headersTimeout: 6000,
        bodyTimeout: 6000,
      });
      if (r.statusCode !== 200) {
        await r.body.dump().catch(() => undefined);
        continue;
      }
      const j = (await r.body.json()) as { Answer?: Array<{ type: number; data: string }> };
      const ips = (j.Answer || [])
        .filter((a) => a.type === 1 && a.data)
        .map((a) => a.data)
        .filter((ip) => !/^127\./.test(ip)); // 回环应答视为「该域名已无可用节点」
      if (ips.length) return ips;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('DoH 全部失败');
}

/** undici Agent.connect.lookup 要求的签名（hostname, options, callback） */
export type DnsLookup = (
  hostname: string,
  options: object | LookupCallback,
  callback?: LookupCallback,
) => void;

/**
 * 构造 lookup 回调：先 DoH（超时 6s），失败或本地回环域名回退 node:dns.lookup。
 * hosts 文件仍由系统 DNS 层生效；DoH 只影响海外被污染域名的解析。
 *
 * ★★ 2026-09-23 修复「TMDB/豆瓣封面链路整条失效」★★
 *   undici 7 调用 connect.lookup 的形态是 `lookup(host, { hints, all: true }, cb)`，
 *   并且**要求 cb(null, [{address, family}, …]) 数组**；老实现一律 `cb(null, ip, 4)` →
 *   undici 报 `Invalid IP address: undefined` → 所有走 DoH Agent 的请求（TMDB 搜索、豆瓣搜索、
 *   TMDB/豆瓣封面出图）**全部失败**，表现为「封面总有几个补不上」甚至「一个都补不上」。
 *   现在：按 options.all 决定回单值还是数组，DoH 与系统 DNS 两条路径形态一致。
 */
export function createDnsLookup(): DnsLookup {
  return ((hostname: string, optsOrCb: object | LookupCallback, maybeCb?: LookupCallback) => {
    const opts = (typeof optsOrCb === 'object' && optsOrCb ? optsOrCb : {}) as { all?: boolean };
    const wantAll = opts.all === true;
    const cb = (typeof optsOrCb === 'function' ? (optsOrCb as LookupCallback) : maybeCb) as LookupCallback | undefined;
    if (typeof cb !== 'function') return;

    /** 统一出口：按 undici 请求的 all 形态回调 */
    const done = (err: Error | null, ip?: string, family = 4): void => {
      if (err || !ip) {
        (cb as unknown as (e: Error | null) => void)(err ?? new Error('no address'));
        return;
      }
      if (wantAll) {
        (cb as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(
          null,
          [{ address: ip, family }],
        );
      } else {
        cb(null, ip, family);
      }
    };
    const viaSystem = (): void => {
      dnsLookup(hostname, { all: true }, (err, addrs) => {
        if (err || !addrs || addrs.length === 0) {
          done(err ?? new Error('DNS 无结果'));
          return;
        }
        if (wantAll) (cb as unknown as (e: null, a: unknown[]) => void)(null, addrs);
        else done(null, addrs[0].address, addrs[0].family);
      });
    };

    // 本地回环/局域网不改写（交给系统 DNS）
    if (/^(localhost|127\.|::1|10\.|192\.168\.|169\.254\.)/i.test(hostname)) {
      viaSystem();
      return;
    }
    void dohResolve(hostname, DOH_SERVERS)
      .then((ips) => done(null, ips[0]))
      .catch(() => viaSystem());
  }) as DnsLookup;
}

/** 带 DoH 的 undici Agent（供 TMDB 等海外 API 使用；普通国内请求仍走默认 Agent） */
export function createDohAgent(): Agent {
  return new Agent({
    connect: {
      timeout: 30000,
      // @ts-expect-error undici 类型未完全覆盖 connect.lookup，运行时生效
      lookup: createDnsLookup(),
    },
  });
}