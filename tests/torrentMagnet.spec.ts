// tests/torrentMagnet.spec.ts — 磁力（BT）播放纯函数层（★ 2026-09-29 方案 B：aria2c sidecar + 外部播放器接力）
// 约定：只用离线数据；涉及 aria2 真机行为的点（bitfield 位序、followedBy 数组）都有真机取证，见注释。
import { describe, it, expect } from 'vitest';
import {
  parseMagnet,
  normalizeBtih,
  withTrackers,
  withTorrentOffsets,
  extOf,
  isVideoFile,
  pickVideoFile,
  webPlayBlockReason,
  addUriOptions,
  magnetKey,
  firstFollowedBy,
  isPieceSet,
  isPieceRangeSet,
  piecesForByteRange,
  parseBtRoute,
  btStreamUrl,
  PUBLIC_TRACKERS,
  BT_HEAD_GATE_BYTES,
} from '../src/engine/torrent/magnet';

// 真机取证的种子（webtorrent 的 Sintel 测试种子）
const HASH_HEX = '08ada5a7a6183aae1e09d831df6748d566095a10';
const HASH_B32 = 'BCW2LJ5GDA5K4HQJ3AY56Z2I2VTASWQQ';

describe('normalizeBtih — infoHash 归一（40hex / 32base32）', () => {
  it('40 位 hex：大小写都归一到小写', () => {
    expect(normalizeBtih(HASH_HEX)).toBe(HASH_HEX);
    expect(normalizeBtih(HASH_HEX.toUpperCase())).toBe(HASH_HEX);
    expect(normalizeBtih(`  ${HASH_HEX}  `)).toBe(HASH_HEX);
  });

  it('32 位 base32（无填充）→ 40 位 hex', () => {
    expect(normalizeBtih(HASH_B32)).toBe(HASH_HEX);
    expect(normalizeBtih(HASH_B32.toLowerCase())).toBe(HASH_HEX);
  });

  it('非法一律空串（长度/字符集不符）', () => {
    expect(normalizeBtih('')).toBe('');
    expect(normalizeBtih('abc')).toBe('');
    expect(normalizeBtih(HASH_HEX.slice(0, 39))).toBe('');
    expect(normalizeBtih(`${HASH_HEX}0`)).toBe('');
    expect(normalizeBtih('0'.repeat(32))).toBe(''); // base32 字符集不含 0/1
    expect(normalizeBtih('!'.repeat(32))).toBe('');
  });
});

describe('parseMagnet — magnet URI 解析', () => {
  it('hex 磁力：infoHash/dn/trackers 齐备', () => {
    const m = parseMagnet(`magnet:?xt=urn:btih:${HASH_HEX}&dn=Sintel&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce`);
    expect(m).not.toBeNull();
    expect(m!.infoHash).toBe(HASH_HEX);
    expect(m!.displayName).toBe('Sintel');
    expect(m!.trackers).toEqual(['udp://tracker.opentrackr.org:1337/announce']);
  });

  it('base32 磁力（大写）→ 归一到 hex', () => {
    const m = parseMagnet(`magnet:?xt=urn:btih:${HASH_B32}`);
    expect(m!.infoHash).toBe(HASH_HEX);
  });

  it('多个 xt 只认 btih；重复 tr 去重；缺 xt 返回 null', () => {
    const m = parseMagnet(`magnet:?xt=urn:sha1:XXXX&xt=urn:btih:${HASH_HEX}&tr=a&tr=a&tr=b`);
    expect(m!.infoHash).toBe(HASH_HEX);
    expect(m!.trackers).toEqual(['a', 'b']);
    expect(parseMagnet(`magnet:?dn=only-name`)).toBeNull();
  });

  it('非 magnet / 空串 → null', () => {
    expect(parseMagnet('https://example.com/a.torrent')).toBeNull();
    expect(parseMagnet('')).toBeNull();
    expect(parseMagnet(`magnet:?xt=urn:btih:zz`)).toBeNull();
  });
});

describe('withTrackers — 追加公共 tracker（只补缺失项）', () => {
  it('自带 tracker 保留，缺失的公共 tracker 被追加', () => {
    const src = `magnet:?xt=urn:btih:${HASH_HEX}&tr=${encodeURIComponent(PUBLIC_TRACKERS[0])}`;
    const out = withTrackers(src);
    expect(out).toContain(`tr=${encodeURIComponent(PUBLIC_TRACKERS[0])}`);
    for (const t of PUBLIC_TRACKERS.slice(1)) expect(out).toContain(`tr=${encodeURIComponent(t)}`);
    // 自带的那条不应重复出现两次
    expect(out.split(encodeURIComponent(PUBLIC_TRACKERS[0])).length - 1).toBe(1);
  });

  it('已含全部公共 tracker → 原样返回（幂等）', () => {
    const src = withTrackers(`magnet:?xt=urn:btih:${HASH_HEX}`);
    expect(withTrackers(src)).toBe(src);
  });

  it('非法磁力原样返回', () => {
    expect(withTrackers('http://x')).toBe('http://x');
  });
});

describe('withTorrentOffsets — torrent 内偏移（决定 piece 映射）', () => {
  it('按文件顺序累加长度（真机 Sintel 数据）', () => {
    const files = withTorrentOffsets([
      { index: 1, path: 'Sintel/Sintel.de.srt', length: 1652 },
      { index: 2, path: 'Sintel/Sintel.en.srt', length: 1514 },
      { index: 6, path: 'Sintel/Sintel.mp4', length: 129241752 },
    ]);
    expect(files[0].offset).toBe(0);
    expect(files[1].offset).toBe(1652);
    expect(files[2].offset).toBe(1652 + 1514); // 前两条 srt 之和
  });

  it('长度字段是字符串（aria2 JSON 里是字符串）也能算', () => {
    const files = withTorrentOffsets([
      { index: 1, path: 'a.mp4', length: '100' as unknown as number },
      { index: 2, path: 'b.mp4', length: '200' as unknown as number },
    ]);
    expect(files.map((f) => f.offset)).toEqual([0, 100]);
    expect(files.map((f) => f.length)).toEqual([100, 200]);
  });
});

describe('选片 — extOf / isVideoFile / pickVideoFile', () => {
  it('扩展名识别（路径分隔符两种、无扩展名、点开头）', () => {
    expect(extOf('a/b/Sintel.MP4')).toBe('mp4');
    expect(extOf('a\\b\\x.mkv')).toBe('mkv');
    expect(extOf('README')).toBe('');
    expect(extOf('.gitignore')).toBe('');
    expect(extOf('noext.')).toBe('');
  });

  it('正片白名单', () => {
    expect(isVideoFile('x.mkv')).toBe(true);
    expect(isVideoFile('x.MP4')).toBe(true);
    expect(isVideoFile('x.srt')).toBe(false);
    expect(isVideoFile('poster.jpg')).toBe(false);
  });

  it('无集名线索 → 取体积最大的正片（字幕/海报不参选）', () => {
    const files = withTorrentOffsets([
      { index: 1, path: 'S.de.srt', length: 1652 },
      { index: 6, path: 'Sintel.mp4', length: 129241752 },
      { index: 11, path: 'poster.jpg', length: 46115 },
    ]);
    expect(pickVideoFile(files)!.index).toBe(6);
  });

  it('有集名线索 → 命中集名（合集包换集场景）', () => {
    const files = withTorrentOffsets([
      { index: 1, path: 'Show.S01E01.1080p.mkv', length: 900_000_000 },
      { index: 2, path: 'Show.S01E02.1080p.mkv', length: 950_000_000 },
    ]);
    expect(pickVideoFile(files, 'S01E02')!.index).toBe(2);
    expect(pickVideoFile(files, '第01集')!.index).toBe(2); // 线索对不上 → 回落体积最大
  });

  it('没有正片 → null', () => {
    expect(pickVideoFile(withTorrentOffsets([{ index: 1, path: 'a.srt', length: 10 }]))).toBeNull();
    expect(pickVideoFile([])).toBeNull();
  });
});

describe('webPlayBlockReason — 是否必须外部播放器接力', () => {
  it('mp4/webm 且非 HEVC → 可直连播（null）', () => {
    expect(webPlayBlockReason('Sintel.mp4')).toBeNull();
    expect(webPlayBlockReason('a/b/x.M4V')).toBeNull();
    expect(webPlayBlockReason('x.webm')).toBeNull();
    expect(webPlayBlockReason('x.h264.mp4')).toBeNull();
  });

  it('非浏览器容器 → 给容器原因', () => {
    expect(webPlayBlockReason('x.mkv')).toContain('MKV');
    expect(webPlayBlockReason('x.avi')).toContain('AVI');
    expect(webPlayBlockReason('x.rmvb')).toContain('RMVB');
    expect(webPlayBlockReason('noext')).toContain('未知');
  });

  it('HEVC 标记（x265/H265/HEVC）即使 mp4 也按外部处理', () => {
    expect(webPlayBlockReason('x.1080p.x265.mp4')).toContain('HEVC');
    expect(webPlayBlockReason('x.H265.WEB-DL.mp4')).toContain('HEVC');
    expect(webPlayBlockReason('电影.HEVC.10bit.mp4')).toContain('HEVC');
    // 词边界：`h2651` 这种不应误判
    expect(webPlayBlockReason('x.h2651.mp4')).toBeNull();
  });
});

describe('aria2 RPC 构造/解析', () => {
  it('addUri 参数：pause-metadata 起手 + select-file 由调用方后设', () => {
    const o = addUriOptions('C:\\tmp\\bt');
    expect(o['pause-metadata']).toBe('true');
    expect(o['bt-save-metadata']).toBe('true');
    expect(o['bt-remove-unselected-file']).toBe('false');
    expect(o['seed-time']).toBe('0');
    expect(o.dir).toBe('C:\\tmp\\bt');
  });

  it('followedBy：1.37 是数组（真机取证），早期是字符串', () => {
    expect(firstFollowedBy(['6a1b'])).toBe('6a1b');
    expect(firstFollowedBy('6a1b')).toBe('6a1b');
    expect(firstFollowedBy([])).toBe('');
    expect(firstFollowedBy(undefined)).toBe('');
    expect(firstFollowedBy([null, 'x'])).toBe('x');
  });

  it('magnetKey：解析失败给空串（调用方据此判非法）', () => {
    expect(magnetKey(`magnet:?xt=urn:btih:${HASH_B32}`)).toBe(HASH_HEX);
    expect(magnetKey('magnet:?dn=x')).toBe('');
  });
});

describe('bitfield — piece 覆盖判定（位序按 aria2 源码：MSB-first）', () => {
  it('单 nibble 内的四个 piece 自高位起（0x8 = 仅 piece0；0x1 = 仅 piece3）', () => {
    expect(isPieceSet('8', 0)).toBe(true);
    expect(isPieceSet('8', 1)).toBe(false);
    expect(isPieceSet('4', 1)).toBe(true);
    expect(isPieceSet('1', 3)).toBe(true);
    expect(isPieceSet('f', 0)).toBe(true);
    expect(isPieceSet('f', 3)).toBe(true);
    // 跨字符：piece 4 落在第 2 个 hex 字符
    expect(isPieceSet('08', 4)).toBe(true);
    expect(isPieceSet('08', 1)).toBe(false);
  });

  it('真机数据：Sintel 首段 hex 33 94 52 21 0x… 的解析（与真机 first40 集合一致）', () => {
    // 真机实测：这段位串下已下载 piece = 2,3,6,7,8,11,13,17,19,22,26,31,36,39
    const hex = '3394522109e74b2080000000';
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => isPieceSet(hex, i))).toEqual([false, false, true, true, false, false, true, true]);
    expect(isPieceSet(hex, 8)).toBe(true); // 0x94 高半字节 9 = 1001 → piece8 置位
    expect(isPieceSet(hex, 11)).toBe(true); // 0x94 低半字节 4 = 0100 → piece11 置位
    expect(isPieceSet(hex, 9)).toBe(false);
  });

  it('越界/非法 hex 一律按未下载（保守，宁可多等不喂零）', () => {
    expect(isPieceSet('', 0)).toBe(false);
    expect(isPieceSet('ff', 8)).toBe(false);
    expect(isPieceSet('zz', 0)).toBe(false);
    expect(isPieceSet('ff', -1)).toBe(false);
  });

  it('区间覆盖：全 1 才算覆盖', () => {
    expect(isPieceRangeSet('ff', 0, 3)).toBe(true);
    expect(isPieceRangeSet('ff', 0, 7)).toBe(true);
    expect(isPieceRangeSet('0f', 0, 3)).toBe(false); // 0f = 仅 piece4-7
    expect(isPieceRangeSet('0f', 4, 7)).toBe(true);
    expect(isPieceRangeSet('f0', 0, 3)).toBe(true); // f0 = 仅 piece0-3
    expect(isPieceRangeSet('f0', 3, 4)).toBe(false);
    expect(isPieceRangeSet('ff', 8, 9)).toBe(false); // 越界（bitfield 太短）
    expect(isPieceRangeSet('00', 3, 2)).toBe(true); // 空区间
  });

  it('文件字节区间 → torrent piece 区间（含文件偏移与跨 piece）', () => {
    // 真机：mp4 偏移 7884、piece 131072
    const r = piecesForByteRange(7884, 131072, 0, 512 * 1024 - 1);
    expect(r).toEqual({ first: 0, last: 4 });
    // 文件内 1MB 处起 1 字节：7884+1048576=1056460 → floor/131072 = 8
    expect(piecesForByteRange(7884, 131072, 1048576, 1048576)).toEqual({ first: 8, last: 8 });
    // pieceLength 异常 → 不炸
    expect(piecesForByteRange(0, 0, 0, 10)).toEqual({ first: 0, last: 0 });
  });
});

describe('/bt 路由与播放地址', () => {
  it('解析 /bt/<hash>/<idx>，非法形态一律 null', () => {
    expect(parseBtRoute(`/bt/${HASH_HEX}/6`)).toEqual({ infoHash: HASH_HEX, fileIndex: 6 });
    expect(parseBtRoute(`/bt/${HASH_HEX}/6/`)).toEqual({ infoHash: HASH_HEX, fileIndex: 6 });
    expect(parseBtRoute(`/bt/${HASH_HEX.toUpperCase()}/6`)).toEqual({ infoHash: HASH_HEX, fileIndex: 6 });
    expect(parseBtRoute(`/bt/${HASH_HEX}/0`)).toBeNull();
    expect(parseBtRoute(`/bt/${HASH_HEX}/x`)).toBeNull();
    expect(parseBtRoute(`/bt/abc/6`)).toBeNull();
    expect(parseBtRoute('/play')).toBeNull();
  });

  it('播放地址拼接（去掉 base 尾部斜杠）', () => {
    expect(btStreamUrl('http://127.0.0.1:9978', HASH_HEX, 6)).toBe(`http://127.0.0.1:9978/bt/${HASH_HEX}/6`);
    expect(btStreamUrl('http://127.0.0.1:9978/', HASH_HEX, 6)).toBe(`http://127.0.0.1:9978/bt/${HASH_HEX}/6`);
  });

  it('首段门控常量合理（>0 且不超过 4MB，避免起播前久等）', () => {
    expect(BT_HEAD_GATE_BYTES).toBeGreaterThan(0);
    expect(BT_HEAD_GATE_BYTES).toBeLessThanOrEqual(4 * 1024 * 1024);
  });
});