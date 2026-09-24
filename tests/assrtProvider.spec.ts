// tests/assrtProvider.spec.ts
// assrtProvider 纯函数单测：hitKeywordQuality（S2）、decodeSubtitle（S3）、isArchive（S6）。
// 网络请求类函数（assrtSearch/detail/fetch）不做单测（依赖外网）。
import { describe, expect, it } from 'vitest';
import * as iconv from 'iconv-lite';
import { hitKeywordQuality, decodeSubtitle, isArchive, subtitleFromBytes } from '../src/main/subtitle/assrtProvider';
import { buildZip } from '../src/engine/util/syncZip';
import type { SubtitleCandidate } from '../src/shared/subtitle';

function cand(title?: string, subname = ''): SubtitleCandidate {
  const c: SubtitleCandidate = { file: '1', subname };
  if (title !== undefined) c.title = title;
  return c;
}

describe('hitKeywordQuality（S2：来源关键词准确度）', () => {
  it('与 title 完全相等（规范化）得分最高', () => {
    const c = cand('繁花');
    expect(hitKeywordQuality(' 繁花 ', c)).toBe(3);
    expect(hitKeywordQuality('繁花', c)).toBe(3);
  });
  it('与 subname 完全相等同样最高分', () => {
    const c = cand('繁花', '繁花.EP11.ass');
    expect(hitKeywordQuality('繁花.EP11.ass', c)).toBe(3);
  });
  it('关键词是标题子串得 2 分（次优）', () => {
    const c = cand('繁花 2023');
    expect(hitKeywordQuality('繁花', c)).toBe(2);
  });
  it('完全无关关键词得 1 分（弱区分，长词更具体）', () => {
    const c = cand('繁花');
    expect(hitKeywordQuality('1845战争', c)).toBe(1);
  });
  it('空关键词返回 -1（不可用）', () => {
    expect(hitKeywordQuality('  ', cand('x'))).toBe(-1);
  });
});

describe('decodeSubtitle（S3：UTF-8 / GBK 判别）', () => {
  it('合法 UTF-8 直接解码', () => {
    const s = '您好，世界 Hello';
    expect(decodeSubtitle(Buffer.from(s, 'utf-8'))).toBe(s);
  });
  it('UTF-8 BOM 剥离', () => {
    const s = '你好';
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s, 'utf-8')]);
    expect(decodeSubtitle(buf)).toBe(s);
  });
  it('UTF-16LE BOM 解码', () => {
    const s = '中文utf16';
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
    expect(decodeSubtitle(buf)).toBe(s);
  });
  it('★ GBK 混 ASCII（纯 ASCII 段往返相等）不再被误判为 UTF-8 → 走 GB18030 解出中文', () => {
    // "Hello 中文" 的 GBK 字节：Hello 是 ASCII，中文 GB2312 双字节；
    // 中=D6D0、文=CEC4（注意 0xD6D0/0xCEC4 作为 UTF-8 双字节序列也是合法的，
    // 旧实现会误判为 UTF-8 解成拉丁乱码——新实现打分选优走 GB18030）
    const s = 'Hello 中文';
    const ascii = Buffer.from('Hello ', 'ascii');
    const gbk = Buffer.concat([ascii, Buffer.from([0xd6, 0xd0, 0xce, 0xc4])]);
    const fakeUtf8 = Buffer.from('Hello 中文', 'utf-8');
    const out = decodeSubtitle(gbk);
    expect(out).toContain('中');
    expect(out).toContain('文');
    expect(out).not.toContain('\uFFFD');
    // 对照：合法 UTF-8 仍正确解出
    expect(decodeSubtitle(fakeUtf8)).toBe('Hello 中文');
  });
  it('非法 UTF-8 序列（单字节 0x80）回退 GB18030 不至于崩', () => {
    const buf = Buffer.from([0x61, 0x80, 0x62]);
    const out = decodeSubtitle(buf);
    expect(typeof out).toBe('string');
  });
  it('★ 2026-09-24 修复：GBK 字幕（必然含换行）不再被解成空串', () => {
    // 真因：textScore 把 \r\n\t（≤0x1F）一律判 -Infinity → GBK 严格 UTF-8 解码失败得空串、
    //      两边同为 -Infinity → 选空串 → 表现为「字幕下载为空 / 挂不上」。
    const srt = '1\r\n00:00:01,000 --> 00:00:02,000\r\n中文字幕测试\r\n';
    const out = decodeSubtitle(iconv.encode(srt, 'gb18030'));
    expect(out).toContain('中文字幕测试');
    expect(out).toContain('-->');
    expect(out).not.toBe('');
  });
});

describe('isArchive（S6：压缩/归档魔数）', () => {
  it('RAR / ZIP / gzip / 7z / bzip2 均识别', () => {
    expect(isArchive(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]))).toBe(true); // Rar!
    expect(isArchive(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true); // ZIP
    expect(isArchive(Buffer.from([0x1f, 0x8b, 0x08, 0x00]))).toBe(true); // gzip
    expect(isArchive(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))).toBe(true); // 7z
    expect(isArchive(Buffer.from([0x42, 0x5a, 0x68, 0x39, 0x31]))).toBe(true); // bzip2 BZh
  });
  it('纯文本 SRT 不被误判为归档', () => {
    const txt = Buffer.from('1\r\n00:00:01,000 --> 00:00:03,000\r\n你好\r\n', 'utf-8');
    expect(isArchive(txt)).toBe(false);
  });
  it('空/短 Buffer 安全返回 false', () => {
    expect(isArchive(Buffer.alloc(0))).toBe(false);
    expect(isArchive(Buffer.from([0x50]))).toBe(false);
  });
});

// ---- ★ 2026-09-24：压缩包 → 解压 → 挑条目 → 解码（此前压缩包直接返回空串 = 100% 挂不上）----
describe('subtitleFromBytes（压缩包字幕可用化）', () => {
  const ASS_TEXT = '[Script Info]\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,你好世界';
  it('zip 内含 ASS + readme → 自动挑出 ASS（含真实文件名/格式/条目数）', async () => {
    const zip = buildZip([
      { name: 'readme.txt', bytes: Buffer.from('站点说明', 'utf-8') },
      { name: '繁花.EP12.ass', bytes: Buffer.from(ASS_TEXT, 'utf-8') },
    ]);
    const r = await subtitleFromBytes(zip, { videoName: '繁花.S01E12.1080p.mkv', ep: '12' });
    expect(r.text).toContain('Dialogue:');
    expect(r.fileName).toBe('繁花.EP12.ass');
    expect(r.format).toBe('ass');
    expect(r.entries).toBe(2);
  });
  it('包内 GBK 编码的 srt 能正确解码（编码判定沿用 decodeSubtitle）', async () => {
    const srt = '1\r\n00:00:01,000 --> 00:00:02,000\r\n中文字幕测试\r\n';
    const gbk = iconv.encode(srt, 'gb18030');
    const zip = buildZip([{ name: 'x.srt', bytes: gbk }]);
    const r = await subtitleFromBytes(zip, {});
    expect(r.text).toContain('中文字幕测试');
    expect(r.fileName).toBe('x.srt');
  });
  it('包内没有字幕文件 → 空文本 + 可读原因（不再静默）', async () => {
    const zip = buildZip([{ name: 'movie.mkv', bytes: Buffer.alloc(200) }]);
    const r = await subtitleFromBytes(zip, {});
    expect(r.text).toBe('');
    expect(r.reason).toContain('未找到字幕文件');
    expect(r.entries).toBe(1);
  });
  it('损坏的 zip → 空文本 + 解压失败原因', async () => {
    const broken = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('garbage-garbage')]);
    const r = await subtitleFromBytes(broken, {});
    expect(r.text).toBe('');
    expect(r.reason).toContain('解压失败');
  });
  it('非归档纯文本 → 直接解码返回（文件名/格式透传）', async () => {
    const r = await subtitleFromBytes(Buffer.from('1\r\n00:00:01,000 --> 00:00:02,000\r\nhi\r\n', 'utf-8'), { fileName: 'a.srt' });
    expect(r.fileName).toBe('a.srt');
    expect(r.format).toBe('srt');
    expect(r.entries).toBe(1);
    expect(r.text).toContain('hi');
  });
});