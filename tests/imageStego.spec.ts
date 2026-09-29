// tests/imageStego.spec.ts — 订阅「图片尾部隐写」提取的纯函数回归。
//
// ★ 参照实现：kankejiang/CatClawVideo `TvBoxSubscriptionManager.cs:548-617`（饭太硬防直连：
//   真实 base64 配置附在图片结束标记之后；另有「盐前缀 + base64」形态，盐长 10 → 4 字节对齐扫不到，
//   必须靠 base64(JSON 开头) 的 `eyJ` / `W1si` / `W3si` 标志定位）。
import { describe, it, expect } from 'vitest';
import { extractStegoConfig, imageKindOf, looksLikeImage } from '../src/engine/util/imageStego';

const b64 = (s: string): string => Buffer.from(s, 'utf-8').toString('base64');

/** 最小 JPEG：SOI + 一段非 FF D9 数据 + EOI */
function jpeg(payload = ''): Buffer {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x02, 0x03]);
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([head, eoi, Buffer.from(payload, 'latin1')]);
}

/** 最小 PNG：签名 + 数据 + IEND + 4 字节 CRC */
function png(payload = ''): Buffer {
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  const iend = Buffer.from('IEND', 'ascii');
  const crc = Buffer.from([0xae, 0x42, 0x60, 0x82]);
  return Buffer.concat([head, iend, crc, Buffer.from(payload, 'latin1')]);
}

const CFG = '{"sites":[{"key":"a","name":"A","type":3,"api":"csp_A"}]}';

describe('extractStegoConfig — 图片尾部隐写', () => {
  it('JPEG：结束标记之后的裸 base64 配置（无盐）', () => {
    const r = extractStegoConfig(jpeg(b64(CFG)));
    expect(r?.text).toBe(CFG);
    expect(r?.kind).toBe('jpeg');
  });

  it('PNG：IEND + CRC 之后的裸 base64 配置', () => {
    const r = extractStegoConfig(png(b64(CFG)));
    expect(r?.text).toBe(CFG);
    expect(r?.kind).toBe('png');
  });

  it('「盐前缀 + base64」形态（盐长 10，与配置黏连后任何 4 字节对齐都解不出）→ 靠 eyJ 标志定位', () => {
    const r = extractStegoConfig(png('Rn5dFaW951' + b64(CFG)));
    expect(r?.text).toBe(CFG);
  });

  it('数组形态（`[{` → 标志 W3si）与盐前缀混在一起也能解', () => {
    const arr = '[{"key":"a","name":"A"}]';
    const r = extractStegoConfig(jpeg('saltzz' + b64(arr)));
    expect(r?.text).toBe(arr);
  });

  it('载荷尾部混入 base64 字符的尾巴（解码后是 JSON 之后的垃圾）→ 退到最后一个 } 再解', () => {
    const r = extractStegoConfig(jpeg(b64(CFG) + 'junkjunk'));
    expect(r?.text).toBe(CFG);
  });

  it('JPEG 末尾取「最后一个 FF D9」：图片数据里混入过 FF D9 也不影响', () => {
    const head = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x11, 0x22]); // 数据段里先出现一次 FF D9
    const buf = Buffer.concat([head, Buffer.from([0xff, 0xd9]), Buffer.from(b64(CFG), 'latin1')]);
    expect(extractStegoConfig(buf)?.text).toBe(CFG);
  });

  it('非图片（明文 JSON / 文本）→ null（本档不参与）', () => {
    expect(extractStegoConfig(Buffer.from(CFG))).toBeNull();
    expect(extractStegoConfig(Buffer.from('hello'))).toBeNull();
    expect(looksLikeImage(Buffer.from(CFG))).toBe(false);
  });

  it('图片但没有尾部载荷 / 载荷是随机垃圾 → null（失败关闭，不误报）', () => {
    expect(extractStegoConfig(jpeg())).toBeNull();
    expect(extractStegoConfig(png('!!!not-base64!!!'))).toBeNull();
    const garbage = Buffer.concat([jpeg(), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x03, 0x04, 0x05, 0x06, 0x07])]);
    expect(extractStegoConfig(garbage)).toBeNull();
  });

  it('载荷解出来不是 JSON 对象/数组（如纯文本）→ null', () => {
    expect(extractStegoConfig(jpeg(b64('just some text')))).toBeNull();
  });

  it('BMP/GIF 被识别为图片（诊断用）但不参与提取', () => {
    const bmp = Buffer.from('BMabcdefgh', 'latin1');
    const gif = Buffer.from('GIF89a', 'latin1');
    expect(imageKindOf(bmp)).toBeNull();
    expect(imageKindOf(gif)).toBeNull();
    expect(looksLikeImage(bmp)).toBe(true);
    expect(looksLikeImage(gif)).toBe(true);
    expect(extractStegoConfig(bmp)).toBeNull();
  });

  it('PNG 载荷里混入假 IEND 文本 → 仍能从正确位置取出（逐候选重试）', () => {
    // 先放一个「假」IEND（后面跟着垃圾），再放真 IEND + CRC + 配置
    const buf = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('IEND', 'ascii'),
      Buffer.from('####'),
      Buffer.from('IEND', 'ascii'),
      Buffer.from([0xae, 0x42, 0x60, 0x82]),
      Buffer.from(b64(CFG), 'latin1'),
    ]);
    expect(extractStegoConfig(buf)?.text).toBe(CFG);
  });
});