// tests/baiduTransfer.spec.ts — 百度解链的纯函数（★ 2026-09-30 新增）
// 覆盖两个真机踩过的协议坑：surl 去首位 `1`、分享页 HTML 的条目解析。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { isBaiduSharePlay, extractBaiduShare, verifySurl, parseShareItems, extractBaiduInnerName, extractBaiduSharedFile, baiduErrnoText, baiduResolveSharedFile, baiduResolveShare, baiduFileDelete, BAIDU_DL_UA } from '../src/main/net/baiduTransfer';

describe('isBaiduSharePlay', () => {
  it('识别百度分享链接（含 jar 的 do=pan 形态）', () => {
    expect(isBaiduSharePlay('https://pan.baidu.com/s/1FQlot5_c063Bdw05ChknbQ?pwd=gtWC')).toBe(true);
    expect(isBaiduSharePlay('PAN.BAIDU.COM/s/1abc-def_x')).toBe(true);
    expect(
      isBaiduSharePlay('http://127.0.0.1:-1/proxy?do=pan&site=baidu&shareId=&fileId=https://pan.baidu.com/s/1FQlot5_c063Bdw05ChknbQ?pwd=gtWC&fileToken='),
    ).toBe(true);
  });
  it('非百度分享不误判', () => {
    expect(isBaiduSharePlay('https://drive.uc.cn/s/2c66665853b34')).toBe(false);
    expect(isBaiduSharePlay('https://pan.quark.cn/s/abc123')).toBe(false);
    expect(isBaiduSharePlay('https://pan.baidu.com/disk/home')).toBe(false);
    expect(isBaiduSharePlay('')).toBe(false);
  });
});

describe('百度分享文件转存链路（不触网）', () => {
  afterEach(() => vi.unstubAllGlobals());

  const file = { shareId: '49252031905', uk: '1100830236519', fsid: '812960976845060', sekey: 'key%2Bwith%2Fslash%3D' };
  const ownFsid = '987654321012345';
  const path = '/Win-Box缓存/01.mp4';
  function network(opts: { moved?: Record<string, unknown>; transfer?: unknown; dlink?: unknown } = {}) {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const u = new URL(String(input));
      let json: unknown;
      switch (u.pathname) {
        case '/api/gettemplatevariable': json = { errno: 0, result: { bdstoken: 'token' } }; break;
        case '/api/create': json = { errno: -8 }; break;
        case '/share/transfer': json = opts.transfer || { errno: 0, extra: { list: [opts.moved || { to: path, to_fs_id: ownFsid }] } }; break;
        case '/api/list': json = { errno: 0, list: [{ path, fs_id: ownFsid, server_filename: '01.mp4', isdir: 0 }] }; break;
        case '/api/filemetas': json = opts.dlink || { errno: 0, info: [{ dlink: 'https://cdn.test/01.mp4' }] }; break;
        default: throw new Error(`unexpected API ${u.pathname}`);
      }
      return new Response(JSON.stringify(json), { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    return fetch;
  }

  it.each(['key%2Bwith%2Fslash%3D', 'key+with/slash='])('只转存所选 fs_id，sekey 编码一次（%s）', async (sekey) => {
    const fetch = network();
    const r = await baiduResolveSharedFile({ ...file, sekey }, 'BDUSS=user; BDCLND=old');
    expect(r).toMatchObject({ ok: true, url: 'https://cdn.test/01.mp4', path, header: { 'User-Agent': BAIDU_DL_UA } });
    const urls = fetch.mock.calls.map(([u]) => new URL(String(u)));
    const transfer = urls.findIndex((u) => u.pathname === '/share/transfer');
    expect(urls[transfer].searchParams.get('shareid')).toBe(file.shareId);
    expect(urls[transfer].searchParams.get('from')).toBe(file.uk);
    expect(urls[transfer].searchParams.get('sekey')).toBe('key+with/slash=');
    const init = (fetch.mock.calls[transfer] as unknown as [string, RequestInit])[1];
    expect(new URLSearchParams(String(init.body)).get('fsidlist')).toBe(`[${file.fsid}]`);
    expect((init.headers as Record<string, string>).Cookie).toBe('BDUSS=user; BDCLND=key%2Bwith%2Fslash%3D');
    expect(urls.find((u) => u.pathname === '/api/filemetas')?.searchParams.get('fsids')).toBe(`[${ownFsid}]`);
    expect(urls.some((u) => /\/share\/(init|verify|list)/.test(u.pathname))).toBe(false);
  });

  it('转存未返回 to_fs_id 时按落盘路径找本人文件，不退回分享者 ID', async () => {
    const fetch = network({ moved: { to: path } });
    const r = await baiduResolveSharedFile(file, 'BDUSS=user');
    expect(r.ok).toBe(true);
    const metas = fetch.mock.calls.map(([u]) => new URL(String(u))).find((u) => u.pathname === '/api/filemetas');
    expect(metas?.searchParams.get('fsids')).toBe(`[${ownFsid}]`);
  });

  it('真实 quota 错误准确上屏，不再提示未知错误/提取码', async () => {
    const fetch = network({ transfer: { errno: 12, info: [{ errno: -32, newno: '31112' }], show_msg: '剩余空间不足，无法转存' } });
    const r = await baiduResolveSharedFile(file, 'BDUSS=user');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('剩余空间不足');
    expect(r.reason).toContain('子错误=-32');
    expect(r.reason).toContain('newno=31112');
    expect(r.reason).not.toContain('未知错误');
    expect(fetch.mock.calls.some(([u]) => String(u).includes('/api/filemetas'))).toBe(false);
  });

  it('只有 show_msg 的空间不足响应也识别为 quota 错误', async () => {
    network({ transfer: { errno: 12, show_msg: '剩余空间不足，无法转存' } });
    expect((await baiduResolveSharedFile(file, 'BDUSS=user')).reason).toContain('剩余空间不足');
  });

  it.each(['/用户文件/01.mp4', '/Win-Box缓存', '/Win-Box缓存/../用户文件/01.mp4', '/Win-Box缓存/./01.mp4', '/Win-Box缓存/'])('清理拒绝缓存外/非规范路径（%s）', async (path) => {
    const fetch = network();
    expect(await baiduFileDelete('BDUSS=user', path)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('落盘位置不在应用缓存内则拒绝，不能登记用户自有路径用于删除', async () => {
    const fetch = network({ moved: { to: '/用户文件/01.mp4', to_fs_id: ownFsid } });
    const r = await baiduResolveSharedFile(file, 'BDUSS=user');
    expect(r.ok).toBe(false);
    expect(r.path).toBeUndefined();
    expect(fetch.mock.calls.some(([u]) => String(u).includes('/api/filemetas'))).toBe(false);
  });

  it('filemetas errno 非零即使有地址也不能当作成功', async () => {
    network({ dlink: { errno: -6, info: [{ dlink: 'https://cdn.test/stale.mp4' }] } });
    expect((await baiduResolveSharedFile(file, 'BDUSS=user')).ok).toBe(false);
  });

  it('缺 Cookie/分享会话时不发请求', async () => {
    const fetch = network();
    expect((await baiduResolveSharedFile(file, '')).ok).toBe(false);
    expect((await baiduResolveSharedFile({ ...file, sekey: '' }, 'BDUSS=user')).ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('普通带提取码分享仍取真实 t、去掉首位 1，并沿用转存链路', async () => {
    const downstream = network();
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input));
      if (u.pathname === '/share/init') return new Response('var data={"t":1791500000000}');
      if (u.pathname === '/share/verify') {
        expect(u.searchParams.get('surl')).toBe('testshare');
        expect(u.searchParams.get('t')).toBe('1791500000000');
        expect(new URLSearchParams(String(init?.body)).get('pwd')).toBe('txr7');
        return new Response('{"errno":0}', { headers: { 'Set-Cookie': 'BDCLND=key%2Bwith%2Fslash%3D; Path=/' } });
      }
      if (u.pathname === '/s/1testshare') return new Response(
        `{"shareid":${file.shareId},"share_uk":"${file.uk}","file_list":[{"fs_id":${file.fsid},"isdir":0,"path":"/01.mp4","server_filename":"01.mp4"}]}`,
      );
      return downstream(input);
    });
    vi.stubGlobal('fetch', fetch);
    const r = await baiduResolveShare('1testshare', 'txr7', 'BDUSS=user', { innerName: '01.mp4' });
    expect(r).toMatchObject({ ok: true, path, header: { 'User-Agent': BAIDU_DL_UA } });
  });
});

describe('extractBaiduShare', () => {
  it('取分享 id（无提取码）', () => {
    expect(extractBaiduShare('https://pan.baidu.com/s/1FQlot5_c063Bdw05ChknbQ')).toEqual({
      short: '1FQlot5_c063Bdw05ChknbQ',
      pwd: '',
    });
  });
  it('取提取码 ?pwd=xxxx（大小写敏感，原样带回）', () => {
    expect(extractBaiduShare('https://pan.baidu.com/s/1FQlot5_c063Bdw05ChknbQ?pwd=gtWC')).toEqual({
      short: '1FQlot5_c063Bdw05ChknbQ',
      pwd: 'gtWC',
    });
  });
  it('能从 jar 的 do=pan 地址里抠出分享（含后续 &fileToken= 参数）', () => {
    const pan = 'http://127.0.0.1:-1/proxy?do=pan&site=baidu&shareId=&fileId=https://pan.baidu.com/s/1jJYCvRQ47rKhE8J4wwciyw?pwd=moCu&fileToken=';
    expect(extractBaiduShare(pan)).toEqual({ short: '1jJYCvRQ47rKhE8J4wwciyw', pwd: 'moCu' });
  });
  it('★ 2026-10-09：yun 旧域名与 share/init?surl= 形态（surl 恒补首位 1）', () => {
    expect(extractBaiduShare('https://yun.baidu.com/s/1FQlot5_c063Bdw05ChknbQ')).toEqual({
      short: '1FQlot5_c063Bdw05ChknbQ',
      pwd: '',
    });
    // surl 定义 = 短 id 去掉首位 1 → 解析时恒补回（与 verifySurl 闭环一致）
    expect(extractBaiduShare('https://pan.baidu.com/share/init?surl=FQlot5_c063Bdw05ChknbQ')?.short).toBe(
      '1FQlot5_c063Bdw05ChknbQ',
    );
    expect(isBaiduSharePlay('https://pan.baidu.com/share/init?surl=abc_1')).toBe(true);
    expect(isBaiduSharePlay('https://yun.baidu.com/s/1abc')).toBe(true);
  });

  it('非百度分享返回 null', () => {
    expect(extractBaiduShare('https://drive.uc.cn/s/abc123?pwd=a1b2')).toBeNull();
    expect(extractBaiduShare('')).toBeNull();
  });
});

// ★ 2026-10-08（用户日志实证：玩偶/花卷/木偶「百度无限」线路全部黑屏且日志无线索）：
//   jar 把分享链接塞进 do=pan 的 query 参数值时会 percent-encode（部分 jar 还会二次编码），
//   旧实现裸正则匹配不到 → 解链静默 return null。这里锁定 encoded/二次编码/非法转义三种形态。
describe('do=pan 的 percent-encoded 形态', () => {
  const encPan =
    'http://127.0.0.1:-1/proxy?do=pan&type=2&site=baidu&shareId=&fileId=https%3A%2F%2Fpan.baidu.com%2Fs%2F1jJYCvRQ47rKhE8J4wwciyw%3Fpwd%3DmoCu&fileToken=';

  it('isBaiduSharePlay 识别 encoded 分享', () => {
    expect(isBaiduSharePlay(encPan)).toBe(true);
  });

  it('extractBaiduShare 解出 encoded 分享 id 与提取码', () => {
    expect(extractBaiduShare(encPan)).toEqual({ short: '1jJYCvRQ47rKhE8J4wwciyw', pwd: 'moCu' });
  });

  it('二次编码同样能解（≤2 轮解码）', () => {
    const twice = 'http://x/proxy?do=pan&fileId=' + encodeURIComponent(encodeURIComponent('https://pan.baidu.com/s/1AbC_d-123?pwd=x9Y2'));
    expect(extractBaiduShare(twice)).toEqual({ short: '1AbC_d-123', pwd: 'x9Y2' });
    expect(isBaiduSharePlay(twice)).toBe(true);
  });

  it('非法百分号序列不抛异常（原文兜底 → null）', () => {
    expect(() => extractBaiduShare('http://x/proxy?do=pan&fileId=%zz%')).not.toThrow();
    expect(extractBaiduShare('http://x/proxy?do=pan&fileId=%zz%')).toBeNull();
  });
});

describe('★ 2026-10-09：百度网盘「播放描述 JSON」（饭太硬系「嘟嘟无限」把这段 JSON 当播放地址返回）', () => {
  const desc =
    '{"pg":"","parent":"","share_id":"33432245846","uk":"1099891027153","surl":"1DssJrJXy-2W4yPXvwew5QA",' +
    '"fs_id":"328674630465284","shareUser":"","path":"%2Fsharelink0-480637669818448%2F%E5%8D%83%E9%87%91%2FE01.mp4"}';
  it('isBaiduSharePlay / extractBaiduShare 认 `surl` 字段并当分享 id', () => {
    expect(isBaiduSharePlay(desc)).toBe(true);
    expect(extractBaiduShare(desc)).toEqual({ short: '1DssJrJXy-2W4yPXvwew5QA', pwd: '' });
    expect(verifySurl('1DssJrJXy-2W4yPXvwew5QA')).toBe('DssJrJXy-2W4yPXvwew5QA');
  });
  it('extractBaiduInnerName：从 path 末段取集名（percent-decode）', () => {
    expect(extractBaiduInnerName(desc)).toBe('E01.mp4');
  });
  it('extractBaiduInnerName：无 path 时退回 name / server_filename；都没有 → 空串', () => {
    expect(extractBaiduInnerName('{"name":"第3集.mkv"}')).toBe('第3集.mkv');
    expect(extractBaiduInnerName('{"server_filename":"a b.mp4"}')).toBe('a b.mp4');
    expect(extractBaiduInnerName('{"surl":"1x"}')).toBe('');
    expect(extractBaiduInnerName('')).toBe('');
  });

  it('extractBaiduSharedFile：保留分享者 fs_id 与同一份 seKey，不误判为本人盘文件', () => {
    expect(extractBaiduSharedFile(
      desc.replace('"path":', '"seKey":"j%2FIwdrbctz32TF%2FumdSllp4XBT7%2F17zj9h2%2F0UYTbHc%3D","path":'),
    )).toEqual({
      shareId: '33432245846',
      uk: '1099891027153',
      fsid: '328674630465284',
      sekey: 'j%2FIwdrbctz32TF%2FumdSllp4XBT7%2F17zj9h2%2F0UYTbHc%3D',
      name: 'E01.mp4',
    });
    expect(extractBaiduSharedFile('{"share_id":"1","uk":"2","fs_id":"3"}')).toBeNull();
  });
});

describe('★ 2026-10-09：baiduErrnoText（errno → 可执行人话；-6 登录失效是关键区分）', () => {
  it('-6 → 引导重新扫码（而非误导成提取码问题）', () => {
    expect(baiduErrnoText(-6)).toContain('重新扫码绑定百度');
  });
  it('-9 → 需要提取码；-12/200025 → 提取码错误', () => {
    expect(baiduErrnoText(-9)).toContain('提取码');
    expect(baiduErrnoText(-12)).toContain('提取码错误');
    expect(baiduErrnoText(200025)).toContain('提取码错误');
  });
  it('116/113 → 分享失效/过期；-20 → 风控验证码；未知 → 未知错误', () => {
    expect(baiduErrnoText(116)).toContain('已失效');
    expect(baiduErrnoText(113)).toContain('过期');
    expect(baiduErrnoText(-20)).toContain('验证码');
    expect(baiduErrnoText(999)).toContain('未知错误');
  });
});

describe('verifySurl', () => {
  // ★ 真机实测：带首位 1 → 恒定 errno 105；去掉后 → errno 0
  it('去掉首位 1（百度分享 id 固定以 1 开头）', () => {
    expect(verifySurl('1FQlot5_c063Bdw05ChknbQ')).toBe('FQlot5_c063Bdw05ChknbQ');
    expect(verifySurl('1utOcrcv4EuQ4juj9jb4ENA')).toBe('utOcrcv4EuQ4juj9jb4ENA');
  });
  it('不以 1 开头则原样返回', () => {
    expect(verifySurl('AbC123')).toBe('AbC123');
    expect(verifySurl('')).toBe('');
  });
});

describe('parseShareItems', () => {
  // 取自真实分享页 yunData 的字段顺序（fs_id / isdir / path 都排在 server_filename 之前）
  const html =
    '<script>var yunData = {"shareid":17378954339,"share_uk":"61009680","file_list":[' +
    '{"category":6,"fs_id":854334938211762,"isdir":1,"path":"/14398-庆余年之风起沧州（74集）范琪 尚雨茜 侍宣如","server_filename":"14398-庆余年之风起沧州（74集）范琪 尚雨茜 侍宣如","size":0}' +
    ']};</script>';

  it('解析出根层目录项', () => {
    const items = parseShareItems(html);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      name: '14398-庆余年之风起沧州（74集）范琪 尚雨茜 侍宣如',
      fsid: '854334938211762',
      isdir: true,
      path: '/14398-庆余年之风起沧州（74集）范琪 尚雨茜 侍宣如',
    });
  });

  it('多条目各归其位，且处理 \\uXXXX 转义', () => {
    const multi =
      '{"fs_id":111,"isdir":0,"path":"/A","server_filename":"01.mp4"},' +
      '{"fs_id":222,"isdir":0,"path":"/B","server_filename":"\\u7b2c02\\u96c6.mkv"}';
    const items = parseShareItems(multi);
    expect(items.map((x) => [x.name, x.fsid, x.isdir])).toEqual([
      ['01.mp4', '111', false],
      ['第02集.mkv', '222', false],
    ]);
  });

  it('没有 fs_id 的（页面里其它地方的 server_filename）跳过', () => {
    expect(parseShareItems('{"server_filename":"无关字符串"}')).toEqual([]);
    expect(parseShareItems('')).toEqual([]);
  });
});
