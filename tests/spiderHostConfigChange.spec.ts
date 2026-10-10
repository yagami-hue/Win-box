// tests/spiderHostConfigChange.spec.ts
// ★ 2026-09-27 事故回归：**「切换选中源」不是配置变更，不得触发任何重活**。
//
// 事故（用户报「摸鱼切换源很慢、一直加载中；从搜索结果返回也很慢」）：
//   `UserConfigManager.setActiveSource()` 走的是通用的 `apply()` → 广播 onConfigChange →
//   `SpiderHost.onUserConfigChange()` 里的**整段重活**：
//     ① 重放整份 SiteConfig；② `vm.spiderFactory.clear()`（丢弃全部已建好的蜘蛛实例）；
//     ③ `searchCache.clear()`（**清掉全源搜索的 5 分钟缓存** → 「搜索→换源→再搜同词」重新跑 100 个源，
//        这正是用户怀疑的「每次切换都重跑了一次所有的源」）；④ 预热 3 个**别的**源的 JVM/Python。
//
// 本测试直接盯 SpiderHost：切源**不得**清这两个缓存；真正的配置变更（增删改源）仍要清。
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shost-cfg-'));
  (globalThis as unknown as { __shostDir: string }).__shostDir = dir;
  return {
    app: { getPath: () => dir, isPackaged: false },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s: string) => Buffer.from(s, 'utf8'),
      decryptString: (b: Buffer) => Buffer.from(b).toString('utf8'),
    },
  };
});

import { rmSync } from 'node:fs';
import { SpiderHost } from '../src/main/spider/SpiderHost';
import type { SourceBean } from '../src/shared/types';

describe('SpiderHost — 全源搜索不把已失败 jar 当成准备中', () => {
  it('真实在途 jar 仍计入 pendingSources，不把准备中源当作失败', async () => {
    const host = new SpiderHost();
    const dir = (globalThis as unknown as { __shostDir: string }).__shostDir;
    try {
      vi.spyOn(host as any, 'searchableSites').mockReturnValue([{ key: 'pending', name: 'pending', type: 3, api: 'csp_Test', searchable: 1 }]);
      const vm = (host as any).vm;
      vi.spyOn(vm.spiderFactory, 'getCSP').mockReturnValue({ runtimeState: () => 'preparing', lastReason: '正在后台下载蜘蛛 jar', pendingRuntime: () => null } as any);
      const search = vi.spyOn(vm, 'search').mockResolvedValue([]);
      const report = await host.searchAll('jar-state-pending', { refresh: true });
      expect(report.pendingSources).toBe(1);
      expect(JSON.stringify(report)).toContain('正在后台下载蜘蛛 jar');
      expect(search).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
  it.each(['before', 'during'])('%s：404/未配置立即跳过，正常源继续搜索，pendingSources 不含失败源', async when => {
    const host = new SpiderHost();
    const dir = (globalThis as unknown as { __shostDir: string }).__shostDir;
    try {
      const sources = ['missing', 'nojar', 'good'].map(key => ({ key, name: key, type: 3, api: 'csp_Test', searchable: 1 } as SourceBean));
      vi.spyOn(host as any, 'searchableSites').mockReturnValue(sources);
      const vm = (host as any).vm;
      const reason = 'jar 下载失败：上游返回 HTTP 404，请检查配置里的 jar 地址';
      const missing = { runtimeState: vi.fn().mockReturnValue('unavailable'), lastReason: reason, pendingRuntime: vi.fn(() => null) };
      if (when === 'during') {
        missing.runtimeState.mockReturnValueOnce('preparing');
        missing.pendingRuntime.mockReturnValue(Promise.resolve() as any);
      }
      const nojar = { runtimeState: () => 'unavailable', lastReason: '该源未指定 jar 地址' };
      vi.spyOn(vm.spiderFactory, 'getCSP').mockImplementation((b: any) => b.key === 'missing' ? missing : b.key === 'nojar' ? nojar : { runtimeState: () => 'ready' });
      const search = vi.spyOn(vm, 'search').mockResolvedValue([]);
      const report = await host.searchAll('jar-state-' + when, { refresh: true });
      expect(search).toHaveBeenCalledTimes(1);
      expect(search.mock.calls[0][0]).toMatchObject({ key: 'good' });
      expect(report.pendingSources || 0).toBe(0);
      expect(JSON.stringify(report)).toContain('HTTP 404');
      expect(JSON.stringify(report)).toContain('未指定 jar 地址');
      expect(JSON.stringify(report)).not.toContain('运行时就绪中');
      if (when === 'before') expect(missing.pendingRuntime).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

function bean(key: string): SourceBean {
  return { key, name: key, type: 0, api: 'https://x/api.php/provide/vod' } as SourceBean;
}

describe('SpiderHost — 切源（ui-only 变更）不得触发重活', () => {
  it('★ cfgSetActiveSource 不清蜘蛛实例缓存、不清全源搜索缓存', () => {
    const host = new SpiderHost();
    const dir = (globalThis as unknown as { __shostDir: string }).__shostDir;
    try {
      host.cfgAddSource(bean('a'));
      host.cfgAddSource(bean('b'));

      const vm = (host as unknown as { vm: { spiderFactory: { clear: () => void } } }).vm;
      const searchCache = (host as unknown as { searchCache: { clear: () => void } }).searchCache;
      const clearSpider = vi.spyOn(vm.spiderFactory, 'clear');
      const clearSearch = vi.spyOn(searchCache, 'clear');

      // ★ 切源 = ui-only：两个缓存都不许被清
      host.cfgSetActiveSource('b');
      expect(clearSpider).not.toHaveBeenCalled();
      expect(clearSearch).not.toHaveBeenCalled();

      // 对照：真正的配置变更（加源）仍会作废旧缓存
      host.cfgAddSource(bean('c'));
      expect(clearSpider).toHaveBeenCalled();
      expect(clearSearch).toHaveBeenCalled();
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

/**
 * ★ 2026-09-27（用户要求「确保每一个需要绑定网盘的都能有这段提示，不管换什么订阅什么源」）：
 *   学习点 = `play()` 里蜘蛛真实产出网盘直链（`matchDriveCookieProvider` 命中）→ `markDriveBindNeeded(key)`。
 *   这里验证「学习 → 暴露给渲染层 → 落盘 → 重新构造宿主后仍在」这条链（不依赖蜘蛛类名清单）。
 */
describe('SpiderHost — 网盘绑定「运行期学习」', () => {
  it('★ markDriveBindNeeded：登记 → 暴露；且跨宿主重建仍保留（落盘）', () => {
    const dir = (globalThis as unknown as { __shostDir: string }).__shostDir;
    try {
      const host = new SpiderHost();
      expect(host.driveBindLearned()).toEqual([]);

      host.markDriveBindNeeded('某新盘源');
      host.markDriveBindNeeded('  某新盘源  '); // 去空白后重复 → 不重复登记
      host.markDriveBindNeeded('');
      expect(host.driveBindLearned()).toEqual(['某新盘源']);

      // 重新构造（模拟重启）：学习结果从 <userData>/drive-bind-learned.json 读回
      const again = new SpiderHost();
      expect(again.driveBindLearned()).toEqual(['某新盘源']);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

/**
 * ★ 2026-09-27（载荷层补完·缺口 B）：**播放前就能学会「要网盘 Cookie」，播放失败要能上屏**。
 *
 * 为什么：原先只在「播放**成功**产出网盘直链」时学习 —— 未绑定 Cookie 时播放必失败，
 * 于是「学不到 → 不显示绑定入口 → 永远绑不上」。详情数据在播放之前就带着答案
 * （实测 wex 玩偶：`vod_play_from = 夸克原画$$$夸克最高急速…`），失败信息也能翻译成可执行提示。
 */
describe('SpiderHost — 详情判定 + 播放失败翻译（缺口 B）', () => {
  it('detail()：播放源名带网盘字样 → 立刻记入绑定清单', async () => {
    const dir = (globalThis as unknown as { __shostDir: string }).__shostDir;
    try {
      const host = new SpiderHost();
      host.cfgAddSource({ key: 'wx', name: 'wx', type: 3, api: 'csp_WoggGuard' } as SourceBean);
      const vm = (host as unknown as { vm: { detail: unknown } }).vm;
      (vm as { detail: unknown }).detail = async () => ({
        id: '1',
        name: 'n',
        flags: ['夸克原画', '夸克最高急速'],
        episodes: { 夸克原画: [{ name: 'x', url: '1be9f9ab|eaa9|qjuH' }] },
      });
      expect(host.driveBindLearned()).toEqual([]);
      await host.detail('wx', ['1']);
      expect(host.driveBindLearned()).toEqual(['wx']);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('★ play()：网盘未绑定的失败 → 返回可上屏的中文提示（不 throw）+ 记入绑定清单', async () => {
    const dir = (globalThis as unknown as { __shostDir: string }).__shostDir;
    try {
      const host = new SpiderHost();
      host.cfgAddSource({ key: 'wx2', name: 'wx2', type: 3, api: 'csp_BrandNewPan' } as SourceBean);
      const vm = (host as unknown as { vm: { play: unknown } }).vm;
      (vm as { play: unknown }).play = async () => {
        throw new Error('org.json.JSONException: JSONObject["data"] not found.');
      };
      const r = await host.play('wx2', '夸克原画', '1be9f9ab');
      // 走既有上屏通道：parse=1 + message（渲染层在播放器上方显示并保底播原始地址）
      expect(r.parse).toBe(1);
      expect(r.message || '').toContain('网盘');
      expect(host.driveBindLearned()).toContain('wx2');
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('play()：普通错误仍按原样抛出（不得被误判成网盘问题）', async () => {
    const dir = (globalThis as unknown as { __shostDir: string }).__shostDir;
    try {
      const host = new SpiderHost();
      host.cfgAddSource({ key: 'cms', name: 'cms', type: 0, api: 'https://x/api.php/provide/vod' } as SourceBean);
      const vm = (host as unknown as { vm: { play: unknown } }).vm;
      (vm as { play: unknown }).play = async () => {
        throw new Error('java.net.UnknownHostException: dead.example.com');
      };
      await expect(host.play('cms', 'HD', '1')).rejects.toThrow('UnknownHostException');
      expect(host.driveBindLearned()).not.toContain('cms');
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
