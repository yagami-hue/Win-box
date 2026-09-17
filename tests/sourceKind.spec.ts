// tests/sourceKind.spec.ts
// ★ 源形态归类：确保设置页「按形态显示字段」的判定稳定。
// 这是 Task「整理 ext 配置界面」的回归护栏 —— 分类错了会把 ext 框藏起来或误留给 CMS 源。
import { describe, it, expect } from 'vitest';
import { sourceKindOf, sourceKindInfo, sourceKindLabel, extRelevant } from '../src/engine/config/sourceKind';

describe('sourceKindOf — type/api 归类', () => {
  it('type=0 → cms-xml，type=1 → cms-json（不走蜘蛛）', () => {
    expect(sourceKindOf({ type: 0, api: 'https://a.com/api.php/provide/vod/' })).toBe('cms-xml');
    expect(sourceKindOf({ type: 1, api: 'https://a.com/api.php/provide/vod/' })).toBe('cms-json');
  });

  it('type=3 按 api 后缀分 js / py / jar', () => {
    expect(sourceKindOf({ type: 3, api: './spider.js' })).toBe('spider-js');
    expect(sourceKindOf({ type: 3, api: 'https://x.com/a.PY' })).toBe('spider-py');
    expect(sourceKindOf({ type: 3, api: 'csp_Doll' })).toBe('spider-jar');
  });

  it('api 带 ;md5; 后缀时仍按主 URL 段判后缀', () => {
    expect(sourceKindOf({ type: 3, api: './x.js;md5;abc' })).toBe('spider-js');
    expect(sourceKindOf({ type: 3, api: 'csp_Fty;md5;abc' })).toBe('spider-jar');
  });

  it('type 2/4/-1 → unsupported（推送类）', () => {
    for (const t of [2, 4, -1]) expect(sourceKindOf({ type: t, api: 'anything' })).toBe('unsupported');
  });
});

describe('sourceKindInfo — 字段需求判定', () => {
  it('CMS 类不需要 ext / jar / playUrl', () => {
    for (const t of [0, 1]) {
      const info = sourceKindInfo({ type: t, api: 'http://x/api' });
      expect(info.usesExt).toBe(false);
      expect(info.usesJar).toBe(false);
      expect(info.usesPlayUrl).toBe(false);
    }
  });

  it('蜘蛛类都需要 ext；只有 jar 蜘蛛需要 jar 字段', () => {
    const js = sourceKindInfo({ type: 3, api: './a.js' });
    const jar = sourceKindInfo({ type: 3, api: 'csp_X' });
    expect(js.usesExt).toBe(true);
    expect(js.usesJar).toBe(false);
    expect(jar.usesExt).toBe(true);
    expect(jar.usesJar).toBe(true);
  });

  it('每个形态都有非空中文说明（设置页会直接展示给用户）', () => {
    for (const t of [0, 1, 3, 2]) {
      const info = sourceKindInfo({ type: t, api: 'csp_X' });
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.how.length).toBeGreaterThan(0);
    }
  });
});

describe('sourceKindLabel / extRelevant 便捷函数', () => {
  it('label 是短标签（表格列用）', () => {
    expect(sourceKindLabel({ type: 0, api: 'x' })).toBe('CMS·XML');
    expect(sourceKindLabel({ type: 3, api: 'csp_X' })).toBe('蜘蛛·JAR');
  });

  it('extRelevant 只在蜘蛛类为真', () => {
    expect(extRelevant({ type: 0, api: 'x' })).toBe(false);
    expect(extRelevant({ type: 1, api: 'x' })).toBe(false);
    expect(extRelevant({ type: 3, api: 'csp_X' })).toBe(true);
    expect(extRelevant({ type: 3, api: './a.js' })).toBe(true);
    expect(extRelevant({ type: 4, api: 'x' })).toBe(false);
  });
});
