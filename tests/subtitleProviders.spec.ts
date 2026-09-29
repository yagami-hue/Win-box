// tests/subtitleProviders.spec.ts
// ★ 2026-09-28：外挂字幕「多源」框架回归。
//   · 网页源（SubtitleCat）的 HTML 解析 / 相关性过滤 / 语言优先级 —— 用**离线 fixture**，不联网；
//   · 多源聚合：逐源并行、单源失败不影响其它源、跳过与失败区分、候选排序；
//   · 下载按候选 provider 路由；
//   · 渲染层的「为什么没字幕」文案。
import { describe, it, expect } from 'vitest';
import {
  parseCatSearch,
  parseCatDetail,
  pickCatDownload,
  catRelevant,
  rankCatRows,
} from '../src/main/subtitle/subtitlecatProvider';
import { providerEnabled, type SubtitleProvider, type SubtitleSearchContext } from '../src/main/subtitle/provider';
import { searchSubtitles, fetchSubtitle, sortCandidates, providerSettingsView } from '../src/main/subtitle';
import { subtitleEmptyReason, subtitleHitSummary, subtitleSourceLabel } from '../src/renderer/lib/subtitleText';
import { DEFAULT_SUBTITLE_SETTINGS, type SubtitleSettings } from '../src/shared/subtitle';

const settings: SubtitleSettings = { ...DEFAULT_SUBTITLE_SETTINGS, providers: { assrt: false, subtitlecat: true } };
const ctx = (title: string, keywords: string[]): SubtitleSearchContext => ({ title, keywords, ep: '12', settings });

// ---- SubtitleCat 搜索页（结构对齐 2026-09-28 **线上实测**页面）----
//   ★ 关键：线上 href 是**不带前导斜杠**的相对路径（`subs/1594/xxx.html`）——
//     曾按“想象”写成 `/subs/`，选择器会一条都匹配不到；这里同时保留两种形态作为回归护栏。
const SEARCH_HTML = `
<table id="search_results">
 <tr>
  <td><a href="subs/1594/Interstellar.English-WWW.MY-SUBS.CO.html">Interstellar.English-WWW.MY-SUBS.CO</a> (translated from English)</td>
  <td class="sub-table__stars">&nbsp;</td>
  <td class="sub-table__metric"><span>Size</span><span>143 KB</span></td>
  <td class="sub-table__metric"><span>Downloads</span><span>7<span> downloads</span></span></td>
  <td class="sub-table__metric"><span>Languages</span><span>7 languages</span></td>
 </tr>
 <tr>
  <td><a href="subs/743/Interstellar.2014.1080p.BluRay.x264.YIFY.html">Interstellar.2014.1080p.BluRay.x264.YIFY</a></td>
  <td>👍</td><td class="sub-table__metric"><span>Size</span><span>134 KB</span></td>
  <td class="sub-table__metric"><span>Downloads</span><span>39<span> downloads</span></span></td>
  <td class="sub-table__metric"><span>Languages</span><span>39 languages</span></td>
 </tr>
 <tr>
  <td><a href="/subs/999/SomeOtherMovie.2020.html">SomeOtherMovie.2020</a></td>
  <td></td><td class="sub-table__metric"><span>Size</span><span>90 KB</span></td>
  <td class="sub-table__metric"><span>Downloads</span><span>99<span> downloads</span></span></td>
  <td class="sub-table__metric"><span>Languages</span><span>2 languages</span></td>
 </tr>
 <tr>
  <td><a href="https://www.subtitlecat.com/subs/1603/Interstellar.English-WWW.MY-SUBS.CO-en.srt">Download</a></td>
  <td>English</td>
 </tr>
</table>`;

// ---- SubtitleCat 详情页 ----
const DETAIL_HTML = `
<table class="table">
 <tr><td>Chinese (Simplified)</td><td><a href="/subs/1639/Interstellar.English-WWW.MY-SUBS.CO-zh-CN.srt">Download</a></td></tr>
 <tr><td>English</td><td><a href="/subs/1603/Interstellar.English-WWW.MY-SUBS.CO-en.srt">Download</a></td></tr>
 <tr><td>Chinese (Traditional)</td><td><a href="/subs/1640/Interstellar.English-WWW.MY-SUBS.CO-zh-TW.srt">Download</a></td></tr>
 <tr><td>Arabic</td><td><a href="https://www.subtitlecat.com/subs/1609/Interstellar.English-WWW.MY-SUBS.CO-ar.srt">Download</a></td></tr>
</table>`;
const DETAIL_EN_ONLY = `
<table><tr><td>English</td><td><a href="/subs/1/X-en.srt">Download</a></td></tr>
<tr><td>Arabic</td><td><a href="/subs/2/X-ar.srt">Download</a></td></tr></table>`;

describe('SubtitleCat — 搜索页解析与筛选', () => {
  it('只取详情页链接（排除 .srt 直链），并解析大小/下载量/语言数', () => {
    const rows = parseCatSearch(SEARCH_HTML);
    expect(rows.map((r) => r.url)).toHaveLength(3);
    expect(rows[0].url).toBe('https://www.subtitlecat.com/subs/1594/Interstellar.English-WWW.MY-SUBS.CO.html');
    expect(rows[1].downloads).toBe(39);
    expect(rows[1].languages).toBe(39);
    expect(rows[1].size).toBe('134 KB');
  });

  it('相关性过滤：与检索词无关的命中被剔除', () => {
    const rows = parseCatSearch(SEARCH_HTML);
    expect(catRelevant('Interstellar.2014.1080p', ['Interstellar'])).toBe(true);
    expect(catRelevant('SomeOtherMovie.2020', ['Interstellar'])).toBe(false);
    expect(rankCatRows(rows, ['Interstellar']).map((r) => r.name)).not.toContain('SomeOtherMovie.2020');
  });

  it('排序：命中更靠前的优先，其次下载量高者优先；limit 生效', () => {
    const rows = parseCatSearch(SEARCH_HTML);
    const ranked = rankCatRows(rows, ['Interstellar'], 1);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].downloads).toBe(39); // 同为前缀命中 → 下载量高的在前
  });

  it('过短关键词不参与相关性判定（避免 1 个字命中一片）', () => {
    expect(catRelevant('AnyMovie', ['A'])).toBe(false);
  });
});

describe('SubtitleCat — 详情页语言优先级', () => {
  it('简中 > 繁中 > 英文；返回绝对地址与原语言名', () => {
    const rows = parseCatDetail(DETAIL_HTML);
    expect(rows.map((r) => r.lang)).toContain('Chinese (Simplified)');
    const picked = pickCatDownload(rows);
    expect(picked?.url).toContain('-zh-CN.srt');
    expect(picked?.url.startsWith('https://')).toBe(true);
    expect(picked?.label).toBe('简中');
  });

  it('只有英文时取英文', () => {
    const picked = pickCatDownload(parseCatDetail(DETAIL_EN_ONLY));
    expect(picked?.url).toContain('-en.srt');
    expect(picked?.label).toBe('英文');
  });

  it('没有可下载行 → null（该条目只有机翻预览）', () => {
    expect(pickCatDownload(parseCatDetail('<table><tr><td>Chinese</td><td>Translate</td></tr></table>'))).toBeNull();
  });
});

describe('多源聚合 — 逐源状态与互不影响', () => {
  const fake = (id: string, impl: Partial<SubtitleProvider>): SubtitleProvider => ({
    id,
    name: id,
    needsToken: false,
    available: () => ({ ok: true }),
    search: async () => [],
    fetch: async () => ({ text: '', fileName: '', reason: 'n/a' }),
    ...impl,
  });

  it('成功的源出候选并标注 provider；失败的源只影响自己；跳过与失败分开记', async () => {
    const a = fake('a', {
      search: async () => [
        { file: 'a1', subname: '剧 第12集', lang: '简体', title: '剧', provider: 'a' },
        { file: 'a2', subname: '剧 第12集', lang: 'English', title: '剧', provider: 'a' },
      ],
    });
    const b = fake('b', {
      available: () => ({ ok: false, reason: '未配置 token' }),
    });
    const c = fake('c', {
      search: async () => {
        throw new Error('站点不可达');
      },
    });
    const report = await searchSubtitles(ctx('剧', ['剧']), [a, b, c]);

    expect(report.candidates.map((x) => x.file)).toEqual(['a1', 'a2']); // 中文优先
    const byId = Object.fromEntries(report.providers.map((p) => [p.id, p]));
    expect(byId.a).toMatchObject({ ok: true, count: 2 });
    expect(byId.b).toMatchObject({ ok: false, skipped: true });
    expect(byId.b.reason).toContain('token');
    expect(byId.c).toMatchObject({ ok: false });
    expect(byId.c.reason).toContain('站点不可达');
    expect(byId.c.skipped).toBeUndefined();
  });

  it('下载按候选 provider 路由；未知 provider 给出可读原因', async () => {
    const a = fake('a', { fetch: async () => ({ text: 'cue', fileName: 'x.ass', format: 'ass' }) });
    const ok = await fetchSubtitle({ file: 'f', subname: 's', provider: 'a' }, ctx('剧', ['剧']), [a]);
    expect(ok.text).toBe('cue');

    const bad = await fetchSubtitle({ file: 'f', subname: 's', provider: 'nope' }, ctx('剧', ['剧']), []);
    expect(bad.reason).toContain('未知的字幕源');
  });
});

describe('候选排序 / 源开关 / 文案', () => {
  it('中文优先，其次标题精确命中，其余保持原顺序（稳定）', () => {
    const out = sortCandidates(
      [
        { file: '1', subname: 'A', lang: 'English', title: 'Other' },
        { file: '2', subname: 'B', lang: '简体', title: 'Other' },
        { file: '3', subname: 'C', lang: '简体', title: '剧名' },
      ],
      '剧名',
    );
    expect(out.map((c) => c.file)).toEqual(['3', '2', '1']);
  });

  it('源开关：未显式关闭视为启用；关掉的源 available 不通过', () => {
    expect(providerEnabled({ ...DEFAULT_SUBTITLE_SETTINGS }, 'subtitlecat')).toBe(true);
    expect(providerEnabled({ ...DEFAULT_SUBTITLE_SETTINGS, providers: { subtitlecat: false } }, 'subtitlecat')).toBe(false);

    const view = providerSettingsView({
      ...DEFAULT_SUBTITLE_SETTINGS,
      providers: { assrt: true, subtitlecat: false },
      assrtToken: '',
    });
    const cat = view.find((v) => v.id === 'subtitlecat');
    const assrt = view.find((v) => v.id === 'assrt');
    if (!cat || !assrt) throw new Error('字幕源视图缺少 subtitlecat / assrt');
    expect(cat).toMatchObject({ enabled: false, available: false });
    expect(assrt).toMatchObject({ enabled: true, available: false, needsToken: true });
    expect(assrt.reason).toContain('token');
  });

  it('无命中文案区分「跳过」与「失败」，并带源名', () => {
    const text = subtitleEmptyReason({
      candidates: [],
      providers: [
        { id: 'assrt', name: 'assrt', ok: false, count: 0, reason: '未配置 assrt token', skipped: true },
        { id: 'subtitlecat', name: 'SubtitleCat', ok: false, count: 0, reason: '无匹配字幕' },
      ],
    });
    expect(text).toContain('未找到匹配字幕');
    expect(text).toContain('已跳过');
    expect(text).toContain('SubtitleCat');
  });

  it('有命中时给出逐源统计；无命中为空串', () => {
    const report = {
      candidates: [],
      providers: [
        { id: 'assrt', name: 'assrt', ok: true, count: 3 },
        { id: 'subtitlecat', name: 'SubtitleCat', ok: false, count: 0, reason: '无匹配字幕' },
      ],
    };
    expect(subtitleHitSummary(report)).toBe('assrt 3');
    expect(subtitleHitSummary({ candidates: [], providers: [] })).toBe('');
    expect(subtitleSourceLabel('subtitlecat')).toBe('SubtitleCat');
    expect(subtitleSourceLabel(undefined)).toBe('');
  });
});
