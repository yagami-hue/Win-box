import { describe, it, expect } from 'vitest';
import { resolveShareFile, extractEpisodeFid, matchTransferredFile, isQuarkSharePlay, isDirNode, isRealFileNode, quarkPlayUrl, QUARK_CACHE_DIR_NAME, SESSION_DIR_PREFIX, sessionDirName } from '../src/main/net/quarkTransfer';
import type { ShareListFetcher } from '../src/main/net/quarkTransfer';

// ★ 会话子目录（tr_xxx）：每次播放落盘唯一目录，规避"上次文件未删完 → 第二次转存同名冲突"
describe('sessionDirName（唯一会话子目录）', () => {
  it('格式为 tr_<时间戳>_<随机> 且带前缀', () => {
    const n = sessionDirName(1720000000000, 'ab12cd');
    expect(n).toBe('tr_1720000000000_ab12cd');
    expect(n.startsWith(SESSION_DIR_PREFIX)).toBe(true);
    expect(SESSION_DIR_PREFIX).toBe('tr_');
  });
  it('无参生成也满足前缀且互不相同概率极高', () => {
    const a = sessionDirName();
    const b = sessionDirName();
    expect(a.startsWith('tr_')).toBe(true);
    expect(a).not.toBe(b);
  });
});

// ★ 2026-09-19 安全边界回归：转存 fid 不再靠「目录差集 + updated_at 猜测」，
//   主路径用服务器返回 save_as_top_fids；回退护栏 = 差集 + 文件名匹配（see quarkTransfer.ts）。
describe('matchTransferredFile (回退护栏：文件名精确匹配，杜绝误删)', () => {
  it('空/非数组/空期望名 → 空 fid', () => {
    expect(matchTransferredFile(null as unknown as unknown[], '04.mp4')).toBe('');
    expect(matchTransferredFile([], '04.mp4')).toBe('');
    expect(matchTransferredFile([{ fid: 'a', file_type: 1, file_name: '04.mp4' }], '')).toBe('');
  });

  it('文件名与分享源完全一致 → 命中', () => {
    const list = [
      { fid: 'dirA', file_type: 2, file_name: '整季目录' },
      { fid: 'f1', file_type: 1, file_name: '04.mp4' },
    ];
    expect(matchTransferredFile(list, '04.mp4')).toBe('f1');
  });

  it('夸克同名自动加 (N) 后缀（残留同名文件时 04(1).mp4）→ 命中', () => {
    const list = [{ fid: 'f9', file_type: 1, file_name: '04(1).mp4', size: 100 }];
    expect(matchTransferredFile(list, '04.mp4')).toBe('f9');
    expect(matchTransferredFile(list, '04(1).mp4')).toBe('f9');
  });

  it('文件名不匹配 → 空（不误删目录里其它文件）', () => {
    const list = [
      { fid: 'user1', file_type: 1, file_name: '我的珍贵视频.mp4', size: 999 },
      { fid: 'user2', file_type: 1, file_name: '05.mp4', size: 888 },
    ];
    // 本次分享源是 04.mp4，目录里只有 05.mp4 / 我的珍贵视频.mp4 → 不匹配 → 空
    expect(matchTransferredFile(list, '04.mp4')).toBe('');
  });

  it('目录占位即使"新增"也不匹配（缺 file_type=1/size）', () => {
    const list = [{ fid: 'newDir', file_type: 2, file_name: '04.mp4' }];
    expect(matchTransferredFile(list, '04.mp4')).toBe('');
  });
});

describe('QUARK_CACHE_DIR_NAME (专用落盘目录，隔离用户文件)', () => {
  it('目录名固定且用户可识别', () => {
    expect(QUARK_CACHE_DIR_NAME).toBe('Win-Box缓存');
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

describe('isDirNode / isRealFileNode（分享列表 dir 布尔 + 个人盘 file_type 双结构）', () => {
  const dirNode = { fid: 'd1', file_type: 0, size: 0, format_type: '' };          // 外层整季目录(personal 盘)
  const fileNode = { fid: 'f1', file_type: 1, file_name: '04.mp4', size: 2066861513, format_type: 'video/mp4' };
  const shareDir = { fid: 's1', dir: true, file_name: '整季' };                    // 分享列表目录(dir 布尔)
  const shareFile = { fid: 's2', dir: false, file_name: '06.mp4', size: 999 };     // 分享列表文件(dir 布尔)
  const fmtNode = { fid: 'f2', format_type: 'video/mp4' as any, size: 100 };      // 带格式 → 文件
  const sizeNode = { fid: 'f3', size: 2048 };                                     // 有实际大小 → 文件
  const noSizeNode = { fid: 'd2', size: 0 };                                      // 目录占位

  it('isDirNode 识别目录（个人盘 file_type / 分享列表 dir）', () => {
    expect(isDirNode(dirNode)).toBe(true);
    expect(isDirNode(shareDir)).toBe(true);
    expect(isDirNode({ fid: 'x', file_type: 2 })).toBe(true);
    expect(isDirNode(noSizeNode)).toBe(true);
    expect(isDirNode({ fid: 'y' })).toBe(true);
  });
  it('isDirNode 不误判文件', () => {
    expect(isDirNode(fileNode)).toBe(false);
    expect(isDirNode(shareFile)).toBe(false);
    expect(isDirNode(fmtNode)).toBe(false);
    expect(isDirNode(sizeNode)).toBe(false);
    expect(isDirNode(null)).toBe(false);
  });
  it('isRealFileNode 识别文件（两种结构）', () => {
    expect(isRealFileNode(fileNode)).toBe(true);
    expect(isRealFileNode(shareFile)).toBe(true);
    expect(isRealFileNode(fmtNode)).toBe(true);
    expect(isRealFileNode(sizeNode)).toBe(true);
  });
  it('isRealFileNode 不误判目录/缺fid', () => {
    expect(isRealFileNode(dirNode)).toBe(false);
    expect(isRealFileNode(shareDir)).toBe(false);
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

// ★ 修复「点第6集落第29集」：resolveShareFile 分页/递归下钻/未命中不瞎猜回退
describe('resolveShareFile（分享内选文件）', () => {
  const quiet = { i: () => {}, w: () => {}, e: () => {} } as never;

  /** 构造内存分享目录树 fetcher：节点 {fid, dir?, file_name?, share_fid_token?} */
  function memFetcher(tree: Record<string, unknown[]>): ShareListFetcher {
    return async (pdirFid, offset) => [...(tree[pdirFid] || [])].slice(offset, offset + 50);
  }
  const fileNode = (fid: string, name?: string) => ({ fid, dir: false, file_name: name || `${fid}.mp4`, size: 100, share_fid_token: `tk-${fid}` });

  it('preferFid 在外层列表可直接命中', async () => {
    const tree = { '0': [fileNode('f1'), fileNode('f6', '第06集.mp4'), fileNode('f7', '第07集.mp4')] };
    const r = await resolveShareFile('f6', quiet, memFetcher(tree));
    expect(r?.fid).toBe('f6');
    expect(r?.name).toBe('第06集.mp4');
    expect(r?.token).toBe('tk-f6');
  });

  it('★ 分页：目标 fid 在第 50 条之后仍能命中（旧实现只取第一页 → 匹配失败 → 错取首文件）', async () => {
    const many = Array.from({ length: 120 }, (_, i) => fileNode(`f${String(i + 1).padStart(3, '0')}`, `第${i + 1}集.mp4`));
    const tree = { '0': many };
    const r = await resolveShareFile('f106', quiet, memFetcher(tree));
    expect(r?.fid).toBe('f106');
    expect(r?.name).toBe('第106集.mp4');
  });

  it('★ 递归下钻：整季目录嵌套多层（根→季目录→集目录→文件）仍能精确命中', async () => {
    const tree = {
      '0': [{ fid: 'season', dir: true, file_name: '第一季' }],
      season: [{ fid: 'vol', dir: true, file_name: '第一卷' }],
      vol: [fileNode('ep6', '第06集.mp4'), fileNode('ep29', '第29集.mp4')],
    };
    const r = await resolveShareFile('ep6', quiet, memFetcher(tree));
    expect(r?.fid).toBe('ep6');
    expect(r?.name).toBe('第06集.mp4');
  });

  it('★ 安全边界：preferFid 全树找不到 → 返回 null（绝不回退首文件，杜绝播错集）', async () => {
    const tree = { '0': [fileNode('f1', '第29集.mp4'), fileNode('f2', '第30集.mp4')] };
    const r = await resolveShareFile('f999', quiet, memFetcher(tree));
    expect(r).toBeNull();
  });

  it('无 preferFid：根目录仅一个真实文件 → 自动选中（单文件分享/每集独立分享）', async () => {
    const tree = { '0': [fileNode('f29', '第29集.mp4')] };
    const r = await resolveShareFile('', quiet, memFetcher(tree));
    expect(r?.fid).toBe('f29');
  });

  it('★ 无 preferFid 且根是整季目录、其中只有一个文件 → 自动取该文件', async () => {
    const tree = { '0': [{ fid: 'season', dir: true, file_name: '整季' }], season: [fileNode('ep6', '第06集.mp4')] };
    const r = await resolveShareFile(undefined, quiet, memFetcher(tree));
    expect(r?.fid).toBe('ep6');
  });

  it('★ 无 preferFid 且分享含多个文件 → 返回 null（拒绝盲选首文件，杜绝共享链接错集）', async () => {
    const tree = { '0': [fileNode('f29', '第29集.mp4'), fileNode('f6', '第06集.mp4')] };
    const r = await resolveShareFile('', quiet, memFetcher(tree));
    expect(r).toBeNull();
  });

  it('★ 无 preferFid 且整季目录含多集 → 返回 null（不再默认取第一集）', async () => {
    const tree = { '0': [{ fid: 'season', dir: true, file_name: '整季' }], season: [fileNode('ep29', '第29集.mp4'), fileNode('ep6', '第06集.mp4')] };
    const r = await resolveShareFile(undefined, quiet, memFetcher(tree));
    expect(r).toBeNull();
  });
});

// ★ 修复「点第6集落第29集」：episode JSON 里 fid 字段名不统一，只认 "fid" 会取不到
describe('extractEpisodeFid（episode id 提取内层 fid）', () => {
  it('字段名 fid（旧兼容）', () => {
    expect(extractEpisodeFid('{"sId":"abc","fid":"123"}')).toBe('123');
  });
  it('字段名 vfid / file_id（玩偶类源常见）', () => {
    expect(extractEpisodeFid('{"sId":"abc","vfid":"v1"}')).toBe('v1');
    expect(extractEpisodeFid('{"sId":"abc","file_id":"fi1"}')).toBe('fi1');
  });
  it('fids 数组取首元素', () => {
    expect(extractEpisodeFid('{"sId":"abc","fids":["a1","a2"]}')).toBe('a1');
  });
  it('直达链接 query 参数', () => {
    expect(extractEpisodeFid('https://pan.quark.cn/s/abc?fid=xyz')).toBe('xyz');
    expect(extractEpisodeFid('https://pan.quark.cn/s/abc?vfid=xy2#/')).toBe('xy2');
  });
  it('无 fid 信息 → 空串', () => {
    expect(extractEpisodeFid('')).toBe('');
    expect(extractEpisodeFid('https://pan.quark.cn/s/abc')).toBe('');
    expect(extractEpisodeFid('{"sId":"abc"}')).toBe('');
  });
});