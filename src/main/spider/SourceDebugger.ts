// src/main/spider/SourceDebugger.ts
// ★ 单源实时诊断：探活(HTTP)+解析计数+实际跑一遍 spider，输出人读结论。
// 用途：排查"空结果"——区分 源站失效 / 接口结构变化 / 缺 ext / 需要 ac 参数 等。
import type { HttpClient, SourceBean, SourceDebugReport, Logger, LiveGroup } from '../../shared/types';
import { parseSortJson, parseAbsJson } from '../../engine/parse/Movie';
import { parseSortXml, parseAbsXml } from '../../engine/parse/AbsXml';
import { validateExtJson } from '../../engine/config/extHelper';
import { sourceAvailability } from '../../engine/vod/sourceAvailability';

interface DebugCtx {
  http: HttpClient;
  logger: Logger;
  globalSpiderJar: string;
}

export async function sourceDebug(bean: SourceBean, ctx: DebugCtx, runHome: (key: string) => Promise<{ ok: boolean; ms: number; classes: number; items: number; head: string; error?: string }>): Promise<SourceDebugReport> {
  const type = bean.type;
  const api = String(bean.api || '').trim();
  const low = api.toLowerCase();
  const kind: SourceDebugReport['kind'] =
    type === 0 ? 'cms-xml' : type === 1 ? 'cms-json' : type === 3 ? (low.endsWith('.js') ? 'js' : low.endsWith('.py') ? 'py' : 'jar') : type === 4 || type === -1 ? 'unsupported' : type === 2 ? 'unknown' : 'unknown';
  const extRaw = String(bean.ext || '').trim();
  const extChk = validateExtJson(extRaw);
  const avail = sourceAvailability(bean);

  const report: SourceDebugReport = {
    key: bean.key,
    type,
    api,
    kind,
    ext: {
      present: extRaw.length > 0,
      jsonOk: extChk.ok,
      preview: extRaw.slice(0, 200) || (extRaw.length === 0 ? '（空）' : ''),
    },
    jarUrl: type === 3 && !low.endsWith('.js') && !low.endsWith('.py') ? (String(bean.jar || '').split(';')[0] || ctx.globalSpiderJar) : '',
    verdict: '',
  };

  if (type === 0 || type === 1) {
    report.probe = await probeCms(api, type, ctx);
    report.verdict = cmsVerdict(report.probe);
  } else if (type === 3) {
    if (!avail.usable) {
      report.verdict = `该类型在桌面版不可用：${avail.hint}`;
      return report;
    }
    const run = await runHome(bean.key);
    report.run = run;
    if (!run.error) {
      const head = (run.head || '').slice(0, 200);
      report.verdict =
        run.items > 0
          ? `实际调用成功：解析出 ${run.items} 条内容${extRaw.length ? '' : '（ext 为空，无需 ext）'}`
          : run.classes > 0
            ? '实际调用成功但首页无条目（只有分类）。请点「首页分类」看内容，或此源的首页本就需先选分类。'
            : head.includes('class') || head.includes('list')
              ? `实际调用返回空数据（JSON 结构在，无条目）：${head}。多因源站失效或该首页需带参数。`
              : '实际调用返回空（无 JSON）。可尝试：① 在编辑里补 ext 配置（见右上模板）；② 若为 csp jar 蜘蛛确认 jar 可达。';
      if (!run.items && extRaw.length === 0 && (kind === 'jar' || kind === 'js')) {
        report.verdict += '【提示】该蜘蛛 ext 为空——部分蜘蛛需要 siteUrl 等配置，可在"编辑→ext"里粘贴模板补全。';
      }
    } else {
      report.verdict = `实际调用失败：${run.error}`;
    }
  } else {
    report.verdict = `type=${type} 在桌面版不可用（安卓同样无运行支持）。请选择 type 0/1 苹果CMS 或 type 3 的 Spider 源。`;
  }
  return report;
}

async function probeCms(api: string, type: number, ctx: DebugCtx): Promise<SourceDebugReport['probe']> {
  const base: SourceDebugReport['probe'] = { url: api, status: 0, bytes: 0, contentType: '', preview: '', parsedOk: false, classes: 0, items: 0 };
  const resp = await ctx.http
    .request({ url: api, method: 'get', timeoutMs: 30000, redirect: 1 })
    .catch((e) => {
      base.error = `网络请求失败：${(e as Error).message}`;
      return null;
    });
  if (!resp) return base;
  base.status = resp.status;
  base.contentType = typeof resp.headers?.['content-type'] === 'string' ? (resp.headers['content-type'] as string) : String(resp.headers?.['content-type'] ?? '');
  const text = Array.isArray(resp.content) ? '' : String(resp.content || '');
  base.bytes = text.length;
  base.preview = text.replace(/\s+/g, ' ').slice(0, 300);
  const sort = type === 0 ? parseSortXml(text) : parseSortJson(text);
  const body = type === 0 ? parseAbsXml(text, '') : parseAbsJson(text, '');
  base.classes = sort.length;
  base.items = body?.movie?.videoList?.length ?? 0;
  base.parsedOk = base.classes > 0 || base.items > 0 || text.includes('class') || text.includes('list');
  return base;
}

function cmsVerdict(p: SourceDebugReport['probe'] | undefined): string {
  if (!p) return '探测未执行';
  if (p.error) return p.error;
  if (p.status === 0) return '探测失败：无法建立连接（源站可能已失效或被墙）。';
  if (p.status >= 400) return `探测失败：HTTP ${p.status}（${p.status === 404 ? '接口地址不存在/已变更' : p.status === 403 ? '被源站拒绝访问，可尝试改 api 加路径或换 UA' : '服务器错误'}）。`;
  if (p.bytes === 0) return `探测：HTTP ${p.status} 但正文为空 —— 源站可能要求额外参数（部分 CMS 需 ?ac=videolist 或在 api 尾加 /at/xml）。`;
  if (p.classes === 0 && p.items === 0) {
    return `探测：HTTP ${p.status}，${p.bytes} 字节，但未解析出分类/条目 —— 多为接口结构变化或返回了错误页/验证页。正文预览：${p.preview.slice(0, 120)}`;
  }
  return `探测正常：HTTP ${p.status}，${p.bytes} 字节，解析出分类 ${p.classes} / 条目 ${p.items}。`;
}
