// tests/detailFix.spec.ts — 详情字段错位纠偏（立播源实测样本）+ 片名兜底
import { describe, expect, it } from 'vitest';
import { fixDetailFields, withFallbackName } from '../src/engine/vod/detailFix';
import type { VodDetail } from '../src/shared/types';

const mk = (p: Partial<VodDetail>): VodDetail => ({
  id: 'x', name: '', pic: '', type: '', year: '', area: '', director: '', actor: '', des: '', remarks: '', flags: [], episodes: {},
  ...p,
});

describe('fixDetailFields — 立播源错位样本', () => {
  const libvio = mk({
    name: '',
    type: '动作,惊悚,犯罪',
    year: '动作,惊悚,犯罪',
    area: '动作,惊悚,犯罪',
    director: '韩国',
    actor: '韩国',
    remarks: '上映 2026-09-09(韩国)',
    des: '故事衔接第一季…',
  });

  it('地区归位（韩国）、导演/演员清空、年份从备注提取', () => {
    const f = fixDetailFields(libvio);
    expect(f.area).toBe('韩国');
    expect(f.director).toBe('');
    expect(f.actor).toBe('');
    expect(f.year).toBe('2026');
    expect(f.type).toBe('动作,惊悚,犯罪'); // 类型本来就是对的，不动
  });

  it('地区已在正确位置时不误伤（area 有效 + 正常导演/演员）', () => {
    const ok = mk({ type: '剧情', year: '2023', area: '中国大陆', director: '秦鹏飞', actor: '刘峰超', remarks: '更新至HD' });
    const f = fixDetailFields(ok);
    expect(f).toMatchObject({ area: '中国大陆', director: '秦鹏飞', actor: '刘峰超', year: '2023', type: '剧情' });
  });

  it('导演/演员恰好等于地区名（另一类错位）→ 清空；语言名同样清空', () => {
    const a = fixDetailFields(mk({ type: '剧情', area: '中国大陆', director: '中国大陆', actor: '韩语', year: '2020' }));
    expect(a.director).toBe('');
    expect(a.actor).toBe('');
    expect(a.area).toBe('中国大陆');
  });

  it('年份为真数字 → 保持；为空且无从推断 → 空串', () => {
    expect(fixDetailFields(mk({ year: '2019' })).year).toBe('2019');
    expect(fixDetailFields(mk({ year: '未知' })).year).toBe('');
  });
});

describe('withFallbackName', () => {
  it('详情 name 为空 → 用列表名兜底；已有名字则不动', () => {
    expect(withFallbackName(mk({ name: '' }), '韩国制造 第二季').name).toBe('韩国制造 第二季');
    expect(withFallbackName(mk({ name: '原片名' }), '列表名').name).toBe('原片名');
    expect(withFallbackName(mk({ name: '' }), '').name).toBe('');
  });
});