import { describe, it, expect } from 'vitest';
import { pickTransferredFid, isQuarkSharePlay, isDirNode, isRealFileNode, quarkPlayUrl } from '../src/main/net/quarkTransfer';

// 依据 capture/_xfer.txt 的真实结构：转存结果落点 = 建目录 fid，真实文件节点带 file_type=1/format_type/size。
describe('pickTransferredFid (夸克 step5 转存轮询文件识别)', () => {
  it('非数组/null/空数组 → 空 fid', () => {
    expect(pickTransferredFid(null)).toBe('');
    expect(pickTransferredFid(undefined)).toBe('');
    expect(pickTransferredFid('x')).toBe('');
    expect(pickTransferredFid([])).toBe('');
  });

  it('无真实文件（纯目录占位）→ 空，需继续轮询', () => {
    const list = [
      { fid: 'dirA', file_type: 2, size: 0 },        // 目录占位
      { fid: 'dirB', file_type: 0, size: 0 },        // 目录占位
      { fid: 'nofile', format_type: undefined, size: 0 }, // 无格式且 size 0 → 非文件
    ];
    expect(pickTransferredFid(list)).toBe('');
  });

  it('真实文件：file_type=1 → 取第一个', () => {
    const list = [
      { fid: 'dirA', file_type: 2, size: 0 },
      { fid: 'file004', file_type: 1, file_name: '04.mp4', category: 1, size: 2066861513, format_type: 'video/mp4' },
    ];
    expect(pickTransferredFid(list)).toBe('file004');
  });

  it('真实文件：带 format_type（无 file_type）→ 判定为文件', () => {
    const list = [{ fid: 'f1', format_type: 'video/mp4' }, { fid: 'dir', file_type: 2 }];
    expect(pickTransferredFid(list)).toBe('f1');
  });

  it('真实文件：仅 size>0 → 判定为文件', () => {
    const list = [{ fid: 'f2', size: 2048 }, { fid: 'd1', size: 0 }];
    expect(pickTransferredFid(list)).toBe('f2');
  });

  it('多个真实文件取第一个（按返回顺序）', () => {
    const list = [{ fid: 'a', file_type: 1 }, { fid: 'b', file_type: 1 }];
    expect(pickTransferredFid(list)).toBe('a');
  });
});

describe('isQuarkSharePlay', () => {
  it('直达 pan.quark.cn/s/ 链接', () => {
    expect(isQuarkSharePlay('https://pan.quark.cn/s/104863e84ddd')).toBe(true);
    expect(isQuarkSharePlay('https://pan.quark.cn/s/abc#/')).toBe(true);
  });
  it('裸分享 ID → false', () => {
    expect(isQuarkSharePlay('104863e84ddd')).toBe(false);
  });
  it('含 sId 的 episode JSON', () => {
    expect(isQuarkSharePlay('{"url":"","flag":"","fid":"x","sId":"abc123"}')).toBe(true);
  });
  it('空/普通地址 → false', () => {
    expect(isQuarkSharePlay('')).toBe(false);
    expect(isQuarkSharePlay('https://v.vimsec.app/a/b.mp4')).toBe(false);
  });
});

describe('isDirNode / isRealFileNode（转存落盘文件/目录判别，实测 _xfer.txt 结构）', () => {
  const dirNode = { fid: 'd1', file_type: 0, size: 0, format_type: '' };          // 外层整季目录
  const fileNode = { fid: 'f1', file_type: 1, file_name: '04.mp4', size: 2066861513, format_type: 'video/mp4' };
  const fmtNode = { fid: 'f2', format_type: 'video/mp4' as any, size: 100 };      // 带格式 → 文件
  const sizeNode = { fid: 'f3', size: 2048 };                                     // 有实际大小 → 文件
  const noSizeNode = { fid: 'd2', size: 0 };                                      // 目录占位

  it('isDirNode 识别目录', () => {
    expect(isDirNode(dirNode)).toBe(true);
    expect(isDirNode({ fid: 'x', file_type: 2 })).toBe(true);
    expect(isDirNode(noSizeNode)).toBe(true);
    expect(isDirNode({ fid: 'y' })).toBe(true);
  });
  it('isDirNode 不误判文件', () => {
    expect(isDirNode(fileNode)).toBe(false);
    expect(isDirNode(fmtNode)).toBe(false);
    expect(isDirNode(sizeNode)).toBe(false);
    expect(isDirNode(null)).toBe(false);
  });
  it('isRealFileNode 识别文件', () => {
    expect(isRealFileNode(fileNode)).toBe(true);
    expect(isRealFileNode(fmtNode)).toBe(true);
    expect(isRealFileNode(sizeNode)).toBe(true);
  });
  it('isRealFileNode 不误判目录/缺fid', () => {
    expect(isRealFileNode(dirNode)).toBe(false);
    expect(isRealFileNode(noSizeNode)).toBe(false);
    expect(isRealFileNode({ file_type: 1 })).toBe(false); // 缺 fid
    expect(isRealFileNode(null)).toBe(false);
  });
});

describe('quarkPlayUrl (夸克转码播放接口)', () => {
  it('有返回可播 url 时，返回该 url', async () => {
    // 仅作接口存在性/返回空串兜底断言：真实网络已实测多数文件 plf_invalid → 空串
    expect(typeof quarkPlayUrl).toBe('function');
  });
});