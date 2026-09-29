// tests/danmakuEndpoints.spec.ts
// ★ 2026-09-26：外部弹幕接口（LogVar / 御坂 / 炊烟袅袅 等自建服务）的单测：
//   地址归一 / 自定义接口解析 / 候选排序与挑选（纯函数）+ 主进程宽松解析 / 会话冷却 / 限并发 / 清单默认开关迁移。
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  customEndpointsText,
  endpointLabel,
  isBuiltinEndpoint,
  joinApi,
  mergeEndpoints,
  normalizeEndpointBase,
  parseCustomEndpoints,
  pickAnimesForExpand,
  rankDanmakuAnimes,
  seasonOf,
  seasonRankOf,
  sortCandidatesByEp,
} from '../src/engine/danmaku/endpoints';
import {
  DanmakuEndpointHealth,
  mapLimit,
  parseEndpointAnimeList,
  parseEndpointEpisodes,
} from '../src/main/danmaku/logvarProvider';
import { DanmakuStore, DANMAKU_ENDPOINTS_REV } from '../src/main/danmaku/DanmakuStore';
import { JsonStore } from '../src/main/store/JsonStore';
import { NullLogger } from '../src/engine/util/logger';
import { DEFAULT_DANMAKU_ENDPOINTS, type DanmakuAnime } from '../src/shared/danmaku';

describe('normalizeEndpointBase / endpointLabel / joinApi', () => {
  it('去尾斜杠、补 https://、保留 token 路径', () => {
    expect(normalizeEndpointBase('https://danmu.0000996.xyz/')).toBe('https://danmu.0000996.xyz');
    expect(normalizeEndpointBase('dm.abai.ccwu.cc/abai')).toBe('https://dm.abai.ccwu.cc/abai');
    expect(normalizeEndpointBase('https://host/token///')).toBe('https://host/token');
    expect(normalizeEndpointBase('  https://dmfl.us.ci  ')).toBe('https://dmfl.us.ci');
  });

  it('非法地址（空/非 http/无主机名）→ 空串', () => {
    expect(normalizeEndpointBase('')).toBe('');
    expect(normalizeEndpointBase('   ')).toBe('');
    expect(normalizeEndpointBase('ftp://example.com/x')).toBe('');
    expect(normalizeEndpointBase('http://')).toBe('');
  });

  it('显示名兜底取 host（去 www.）', () => {
    expect(endpointLabel('https://dm.abai.ccwu.cc/abai')).toBe('dm.abai.ccwu.cc');
    expect(endpointLabel('https://www.example.com/x')).toBe('example.com');
  });

  it('joinApi 先归一 base 再拼路径（含尾斜杠时不会出现双斜杠）', () => {
    expect(joinApi('https://h/t/', '/api/v2/search/anime?keyword=a')).toBe('https://h/t/api/v2/search/anime?keyword=a');
  });
});

describe('parseCustomEndpoints（自定义接口文本）', () => {
  it('支持「名字@URL」与纯 URL（名字取 host），忽略注释/空行/非法行', () => {
    const r = parseCustomEndpoints(
      ['我的源@https://my.example/token', 'https://other.example/api/v1/x', '# 注释', '', '不是地址的一行'].join('\n'),
    );
    expect(r).toEqual([
      { name: '我的源', url: 'https://my.example/token', enabled: true },
      { name: 'other.example', url: 'https://other.example/api/v1/x', enabled: true },
    ]);
  });

  it('同地址去重（先出现者优先）', () => {
    const r = parseCustomEndpoints('A@https://h/t\nB@https://h/t/');
    expect(r).toHaveLength(1);
    expect(r[0].name).toBe('A');
  });
});

describe('mergeEndpoints / customEndpointsText', () => {
  it('内置清单默认只启用「炊烟袅袅」', () => {
    expect(DEFAULT_DANMAKU_ENDPOINTS.filter((e) => e.enabled).map((e) => e.name)).toEqual(['炊烟袅袅']);
    expect(DEFAULT_DANMAKU_ENDPOINTS[0].url).toBe('https://danmu.cynn.top/cynnsq');
  });

  it('保留内置开关状态、补齐缺失内置项、追加自定义且不重复', () => {
    const current = DEFAULT_DANMAKU_ENDPOINTS.map((e, i) => ({ ...e, enabled: i !== 0 }));
    const r = mergeEndpoints(current, '某源@https://big.example/tok\n稳健@https://dandan.wenjian.de/wenjian/');
    expect(r).toHaveLength(DEFAULT_DANMAKU_ENDPOINTS.length + 1);
    expect(r[0]).toEqual({ ...DEFAULT_DANMAKU_ENDPOINTS[0], enabled: false }); // 关掉的仍在（开关保留）
    expect(r[r.length - 1]).toEqual({ name: '某源', url: 'https://big.example/tok', enabled: true });
  });

  it('缺失的内置项按「内置默认开关」补（不是一律打开）', () => {
    // 只留炊烟袅袅一项 → 其余内置项补齐时应保持默认关闭
    const r = mergeEndpoints([{ ...DEFAULT_DANMAKU_ENDPOINTS[0] }], '');
    expect(r).toHaveLength(DEFAULT_DANMAKU_ENDPOINTS.length);
    expect(r.find((x) => x.url === 'https://dm.abai.ccwu.cc/abai')?.enabled).toBe(false);
    expect(r.find((x) => x.url === 'https://danmu.cynn.top/cynnsq')?.enabled).toBe(true);
  });

  it('customEndpointsText 只回显非内置项', () => {
    const list = [
      { name: 'LogVar', url: 'https://dm.abai.ccwu.cc/abai', enabled: true },
      { name: '我的', url: 'https://mine.example/x', enabled: true },
    ];
    expect(customEndpointsText(list)).toBe('我的@https://mine.example/x');
    expect(isBuiltinEndpoint('https://dm.abai.ccwu.cc/abai')).toBe(true);
    expect(isBuiltinEndpoint('https://mine.example/x')).toBe(false);
  });
});

describe('DanmakuStore — 清单默认开关迁移（★ rev2 默认只开炊烟袅袅）', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmpFile = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'dmstore-'));
    dirs.push(d);
    return join(d, 'danmaku.json');
  };

  it('无存盘 → 内置默认（仅炊烟袅袅开）', () => {
    const s = new DanmakuStore(tmpFile(), NullLogger);
    expect(s.settings.endpoints.filter((e) => e.enabled).map((e) => e.name)).toEqual(['炊烟袅袅']);
  });

  it('旧配置（全开、无 endpointsRev）→ 内置项回到默认开关，用户自定义项保留', () => {
    const file = tmpFile();
    const raw = new JsonStore(file);
    raw.setObject('settings', {
      enabled: true,
      fontSize: 20,
      endpoints: [
        { name: '炊烟袅袅', url: 'https://danmu.cynn.top/cynnsq', enabled: true },
        { name: '御坂', url: 'https://dmk.abai.ccwu.cc/api/v1/abaibai', enabled: true },
        { name: '我的', url: 'https://mine.example/x', enabled: true },
      ],
    });
    raw.flush();
    const s = new DanmakuStore(file, NullLogger);
    const on = s.settings.endpoints.filter((e) => e.enabled).map((e) => e.name);
    expect(on.sort()).toEqual(['我的', '炊烟袅袅']);
    expect(s.settings.fontSize).toBe(20); // 其余偏好不受迁移影响
    // 迁移后保存一次 → 记修订号；重新读取时不再重置开关
    s.update({ fontSize: 21 });
    const raw2 = new JsonStore(file).getObject<{ endpointsRev?: number }>('settings', {});
    expect(raw2.endpointsRev).toBe(DANMAKU_ENDPOINTS_REV);
    const s2 = new DanmakuStore(file, NullLogger);
    expect(s2.settings.endpoints.filter((e) => e.enabled).map((e) => e.name).sort()).toEqual(['我的', '炊烟袅袅']);
  });

  it('rev2 配置：面板关掉炊烟袅袅后重读仍为关（不按默认重置）', () => {
    const file = tmpFile();
    const s = new DanmakuStore(file, NullLogger);
    s.update({ endpoints: s.settings.endpoints.map((e) => ({ ...e, enabled: false })) });
    expect(s.settings.endpoints.filter((e) => e.enabled)).toHaveLength(0);
    const s2 = new DanmakuStore(file, NullLogger);
    expect(s2.settings.endpoints.filter((e) => e.enabled)).toHaveLength(0);
  });
});

describe('rankDanmakuAnimes / pickAnimesForExpand', () => {
  const a = (title: string, source = '', animeId = 1): DanmakuAnime => ({ animeId, title, bangumiId: animeId, source, sourceName: source });

  it('完全同名排最前；同来源同名去重；档内保持原顺序', () => {
    const r = rankDanmakuAnimes(
      [a('庆余年 第二季', 's1', 1), a('庆余年', 's2', 2), a('庆余年', 's2', 3), a('庆余年特别版', 's3', 4), a('无关剧', 's4', 5)],
      '庆余年',
    );
    expect(r.map((x) => [x.title, x.source])).toEqual([
      ['庆余年', 's2'],
      ['庆余年 第二季', 's1'],
      ['庆余年特别版', 's3'],
      ['无关剧', 's4'],
    ]);
  });

  it('展开挑选：来源多样性优先（每来源先取第一部），再按序补足', () => {
    const list = [a('A', 's1', 1), a('B', 's1', 2), a('C', 's2', 3), a('D', 's3', 4)];
    expect(pickAnimesForExpand(list, 3).map((x) => x.title)).toEqual(['A', 'C', 'D']);
    expect(pickAnimesForExpand(list, 5)).toHaveLength(4);
  });
});

describe('seasonOf / seasonRankOf / 季号感知排序（★ 2026-09-26）', () => {
  it('季号提取：中文季 / S01E01 / Season N / 汉字数字；无季信息 → undefined', () => {
    expect(seasonOf('绝命毒师 第一季 第01集')).toBe(1);
    expect(seasonOf('绝命毒师第二季(2009)【电视剧】from tencent')).toBe(2);
    expect(seasonOf('Breaking.Bad.S01E01.1080p')).toBe(1);
    expect(seasonOf('Some Show Season 3')).toBe(3);
    expect(seasonOf('某某剧 第十季')).toBe(10);
    expect(seasonOf('火影忍者')).toBeUndefined();
    expect(seasonOf('1080p HDTV')).toBeUndefined();
  });

  it('季契合度：同季 0 / 标题无季信息 1 / 不同季 2；未给期望季恒为 1', () => {
    expect(seasonRankOf('绝命毒师第一季(2008)', 1)).toBe(0);
    expect(seasonRankOf('绝命毒师第1季(2008)', 1)).toBe(0);
    expect(seasonRankOf('绝命毒师：续命之徒(2019)', 1)).toBe(1);
    expect(seasonRankOf('绝命毒师第五季(2012)', 1)).toBe(2);
    expect(seasonRankOf('绝命毒师第五季(2012)', undefined)).toBe(1);
  });

  it('给期望季：同季优先、同季内集数多者优先；未给季 → 保持原稳定顺序', () => {
    // 实测数据形态（炊烟袅袅/稳健：tencent 全是花絮条目，360 才是真季集）
    const list: DanmakuAnime[] = [
      { animeId: 1, bangumiId: 1, title: '绝命毒师第五季(2012)【电视剧】from tencent', episodeCount: 6, source: 's1', sourceName: '炊烟袅袅' },
      { animeId: 2, bangumiId: 2, title: '绝命毒师第四季(2011)【电视剧】from tencent', episodeCount: 2, source: 's1', sourceName: '炊烟袅袅' },
      { animeId: 3, bangumiId: 3, title: '绝命毒师第一季(2008)【电视剧】from tencent', episodeCount: 1, source: 's1', sourceName: '炊烟袅袅' },
      { animeId: 4, bangumiId: 4, title: '绝命毒师第1季(2008)【电视剧】from 360', episodeCount: 7, source: 's2', sourceName: '稳健' },
    ];
    expect(rankDanmakuAnimes(list, '绝命毒师', 1).map((x) => x.animeId)).toEqual([4, 3, 1, 2]);
    expect(rankDanmakuAnimes(list, '绝命毒师').map((x) => x.animeId)).toEqual([1, 2, 3, 4]);
  });
});

describe('parseEndpointAnimeList / parseEndpointEpisodes（宽松解析）', () => {
  it('搜索响应：bangumiId 缺失用 animeId 兜底；字符串 id 归一为 number；带来源标记与集数', () => {
    const r = parseEndpointAnimeList(
      { animes: [{ animeId: 1094757867, animeTitle: ' 火影忍者 ', type: 'tvseries', episodeCount: 66 }] },
      'https://h/t',
      '稳健',
    );
    expect(r).toEqual([
      {
        animeId: 1094757867,
        bangumiId: 1094757867,
        title: '火影忍者',
        kind: 'tvseries',
        episodeCount: 66,
        source: 'https://h/t',
        sourceName: '稳健',
      },
    ]);
  });

  it('搜索响应结构异常（非对象/无 animes 数组）→ null（调用方据此记冷却）', () => {
    expect(parseEndpointAnimeList({ error: 'x' }, 's', 'n')).toBeNull();
    expect(parseEndpointAnimeList('bad', 's', 'n')).toBeNull();
    expect(parseEndpointAnimeList({ animes: [] }, 's', 'n')).toEqual([]);
  });

  it('剧集响应：episodes 缺失 → null；正常项带来源；数字字符串 id 兼容', () => {
    expect(parseEndpointEpisodes({ bangumi: {} }, 's', 'n')).toBeNull();
    const r = parseEndpointEpisodes(
      { bangumi: { animeTitle: '某剧', episodes: [{ episodeId: '23505605', episodeTitle: ' 第1话 ' }] } },
      'https://h/t',
      'LogVar',
    );
    expect(r).toEqual([
      { episodeId: 23505605, title: '某剧', episodeTitle: '第1话', source: 'https://h/t', sourceName: 'LogVar' },
    ]);
  });

  it('★ 2026-09-29：集号字段 episodeNumber（数字/数字串）解析为 episodeNumber；非数字忽略', () => {
    const r = parseEndpointEpisodes(
      {
        bangumi: {
          episodes: [
            { episodeId: 1, episodeTitle: '【qq】 第1集 菜头萧萧', episodeNumber: '1' },
            { episodeId: 2, episodeTitle: '正片', episodeNumber: 2 },
            { episodeId: 3, episodeTitle: '花絮', episodeNumber: 'SP' },
          ],
        },
      },
      's',
      'n',
    );
    expect(r?.map((x) => x.episodeNumber)).toEqual(['1', '2', undefined]);
  });
});

describe('DanmakuEndpointHealth（会话级冷却）', () => {
  it('首次失败冷却较短、重复失败冷却更长；成功清零；冷却中计数正确', () => {
    const h = new DanmakuEndpointHealth(1000, 5000);
    const now = 100000;
    expect(h.isCooling('a', now)).toBe(false);
    h.markFail('a', now);
    expect(h.isCooling('a', now + 999)).toBe(true);
    expect(h.isCooling('a', now + 1000)).toBe(false);
    h.markFail('a', now);
    h.markFail('a', now); // 第二次 → 更长冷却
    expect(h.isCooling('a', now + 4999)).toBe(true);
    expect(h.coolingCount(now + 10)).toBe(1);
    h.markOk('a');
    expect(h.isCooling('a', now + 1)).toBe(false);
    expect(h.coolingCount(now + 1)).toBe(0);
  });
});

describe('mapLimit（限并发且保序）', () => {
  it('并发不超过上限、结果顺序与输入一致', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return n * 2;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
  });
});

// ★ 2026-09-28（用户要求）：候选列表显示排序 —— 有集数的按集号升序在前，没集数的沉底
describe('sortCandidatesByEp（候选列表按集号排序）', () => {
  const c = (episodeTitle?: string, tag = '') => ({ episodeTitle, source: tag, sourceName: tag, episodeId: 0 });

  it('混排：有集号按升序在前，无集号沉底且保持原顺序', () => {
    const list = [c('预告', 'a'), c('第10集', 'b'), c(undefined, 'c'), c('第2集', 'd'), c('幕后花絮', 'e')];
    const out = sortCandidatesByEp(list);
    expect(out.map((x) => x.episodeTitle)).toEqual(['第2集', '第10集', '预告', undefined, '幕后花絮']);
  });

  it('SxxExx / 纯数字 / 第N话 都算集号', () => {
    const out = sortCandidatesByEp([c('SP', 'a'), c('12', 'b'), c('S02E03', 'c'), c('第4话', 'd')]);
    expect(out.map((x) => x.episodeTitle)).toEqual(['S02E03', '第4话', '12', 'SP']);
  });

  it('同集号保持原相对顺序（稳定），空列表安全', () => {
    const out = sortCandidatesByEp([c('第1集', 'x'), c('第1集', 'y')]);
    expect(out.map((x) => x.source)).toEqual(['x', 'y']);
    expect(sortCandidatesByEp([])).toEqual([]);
  });

  it('★ 2026-09-29：只有 episodeNumber（标题提不出集号）也能排序 —— 修 tencent 条目看不到集号', () => {
    const list = [
      { episodeId: 1, episodeTitle: '【qq】 正片', episodeNumber: '3', source: 'a', sourceName: 'a' },
      { episodeId: 2, episodeTitle: undefined, episodeNumber: '1', source: 'b', sourceName: 'b' },
      { episodeId: 3, episodeTitle: '花絮', source: 'c', sourceName: 'c' },
      { episodeId: 4, episodeTitle: undefined, episodeNumber: '2', source: 'd', sourceName: 'd' },
    ];
    expect(sortCandidatesByEp(list).map((x) => x.source)).toEqual(['b', 'd', 'a', 'c']);
  });
});