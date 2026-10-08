// tests/mpvCore.spec.ts
// ★ 2026-10-08（用户拍板「内置官方构建」）：MPV 高兼容播放内核的纯逻辑回归 ——
//   启动参数 / JSON IPC 行协议 / 状态归一 / 画面比例与字幕换算 / mpv.exe 路径解析链。
import { describe, it, expect } from 'vitest';
import {
  buildMpvArgs,
  initialKernelState,
  mpvCmdLine,
  mpvCommandLines,
  mpvFitProps,
  mpvObserveLines,
  reduceMpvMessage,
  resolveMpvPath,
} from '../src/main/player/mpvCore';
import { mpvFontSize, mpvSubPos } from '../src/shared/player';

describe('mpvCore · 启动参数', () => {
  it('关键旗标齐全：--wid 嵌入 / JSON IPC / idle / keep-open / 硬解 / 不抢输入', () => {
    const args = buildMpvArgs({ pipe: '\\\\.\\pipe\\winbox-mpv-1', wid: '123456' });
    expect(args).toContain('--wid=123456');
    expect(args).toContain('--input-ipc-server=\\\\.\\pipe\\winbox-mpv-1');
    expect(args).toContain('--idle=yes');
    expect(args).toContain('--keep-open=yes');
    expect(args).toContain('--hwdec=auto-safe');
    expect(args).toContain('--input-default-bindings=no');
    expect(args).toContain('--no-config');
  });

  it('起播位置/音量/倍速按需带上（0 或缺省不传）', () => {
    const a = buildMpvArgs({ pipe: 'p', wid: '1', start: 123.9, volume: 0.5, rate: 1.5 });
    expect(a).toContain('--start=123');
    expect(a).toContain('--volume=50');
    expect(a).toContain('--speed=1.5');
    const b = buildMpvArgs({ pipe: 'p', wid: '1' });
    expect(b.some((x) => x.startsWith('--start='))).toBe(false);
    expect(b.some((x) => x.startsWith('--volume='))).toBe(false);
    expect(b.some((x) => x.startsWith('--speed='))).toBe(false);
  });

  it('画面比例展开为 mpv 属性（fill = keepaspect no；cover = panscan 1.0；r169 = 16:9）', () => {
    const fill = buildMpvArgs({ pipe: 'p', wid: '1', fit: 'fill' });
    expect(fill).toContain('--keepaspect=no');
    const cover = buildMpvArgs({ pipe: 'p', wid: '1', fit: 'cover' });
    expect(cover).toContain('--panscan=1.0');
    const r169 = buildMpvArgs({ pipe: 'p', wid: '1', fit: 'r169' });
    expect(r169).toContain('--video-aspect-override=16:9');
    const none = buildMpvArgs({ pipe: 'p', wid: '1', fit: 'none' });
    expect(none).toContain('--video-unscaled=yes');
  });

  it('倍速越界被钳到 [0.25,4]；音量 0..1 换算为 0..100', () => {
    const a = buildMpvArgs({ pipe: 'p', wid: '1', volume: 2, rate: 99 });
    expect(a).toContain('--volume=130'); // 0..130（mpv 上限）
    expect(a).toContain('--speed=99'); // 启动参数不钳，运行期命令钳（见 mpvCommandLines）
    const lines = mpvCommandLines({ type: 'rate', value: 99 });
    expect(lines[0]).toContain('"speed",4');
  });
});

describe('mpvCore · JSON IPC 协议', () => {
  it('命令行以 JSON + \\n 结束（mpv 读行）', () => {
    const line = mpvCmdLine(['loadfile', 'http://x/a.mkv', 'replace']);
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line.trim())).toEqual({ command: ['loadfile', 'http://x/a.mkv', 'replace'] });
  });

  it('属性观察覆盖 时间/时长/暂停/缓冲/结束/尺寸/缓存', () => {
    const names = mpvObserveLines().map((l) => JSON.parse(l.trim()).command[2]);
    for (const n of ['time-pos', 'duration', 'pause', 'paused-for-cache', 'eof-reached', 'width', 'height', 'cache-speed', 'demuxer-cache-time']) {
      expect(names).toContain(n);
    }
  });

  it('控制命令 → mpv 命令（play/pause/seek/volume/rate/fit/字幕）', () => {
    expect(mpvCommandLines({ type: 'play' })[0]).toContain('"pause","no"');
    expect(mpvCommandLines({ type: 'pause' })[0]).toContain('"pause","yes"');
    expect(mpvCommandLines({ type: 'seek', value: 42 })[0]).toContain('"seek",42,"absolute"');
    expect(mpvCommandLines({ type: 'volume', value: 0.4 })[0]).toContain('"volume",40');
    expect(mpvCommandLines({ type: 'fit', value: 'r43' }).join('')).toContain('"video-aspect-override","4:3"');
    expect(mpvCommandLines({ type: 'sub-font', value: 30 })[0]).toContain('"sub-font-size",60');
    expect(mpvCommandLines({ type: 'sub-pos', value: 88 })[0]).toContain('"sub-pos",88');
  });

  it('未知命令返回空（不发明 API）', () => {
    expect(mpvCommandLines({ type: 'nope' } as never)).toEqual([]);
  });
});

describe('mpvCore · 状态归一', () => {
  it('property-change 逐项映射（含 duration=null 表未知）', () => {
    const s = initialKernelState();
    reduceMpvMessage(s, { event: 'property-change', name: 'time-pos', data: 12.5 });
    reduceMpvMessage(s, { event: 'property-change', name: 'duration', data: 7200.0 });
    reduceMpvMessage(s, { event: 'property-change', name: 'pause', data: true });
    reduceMpvMessage(s, { event: 'property-change', name: 'paused-for-cache', data: true });
    reduceMpvMessage(s, { event: 'property-change', name: 'width', data: 3840 });
    reduceMpvMessage(s, { event: 'property-change', name: 'height', data: 2160 });
    reduceMpvMessage(s, { event: 'property-change', name: 'cache-speed', data: 2 * 1024 * 1024 });
    reduceMpvMessage(s, { event: 'property-change', name: 'demuxer-cache-time', data: 300 });
    expect(s.time).toBe(12.5);
    expect(s.duration).toBe(7200);
    expect(s.paused).toBe(true);
    expect(s.buffering).toBe(true);
    expect(s.videoW).toBe(3840);
    expect(s.videoH).toBe(2160);
    expect(s.cacheKbps).toBe(2048);
    expect(s.cacheTime).toBe(300);
    reduceMpvMessage(s, { event: 'property-change', name: 'duration', data: null });
    expect(s.duration).toBeNull();
  });

  it('file-loaded：loaded=true；时长未知 ⇒ 直播', () => {
    const vod = initialKernelState();
    reduceMpvMessage(vod, { event: 'property-change', name: 'duration', data: 100 });
    reduceMpvMessage(vod, { event: 'file-loaded' });
    expect(vod.loaded).toBe(true);
    expect(vod.live).toBe(false);
    const live = initialKernelState();
    reduceMpvMessage(live, { event: 'file-loaded' });
    expect(live.live).toBe(true);
  });

  it('eof：end-file(reason=eof) 或 eof-reached 置位；无关消息与重复消息不产生变化', () => {
    const s = initialKernelState();
    expect(reduceMpvMessage(s, { event: 'end-file', reason: 'stop' })).toBe(false);
    expect(reduceMpvMessage(s, { event: 'end-file', reason: 'eof' })).toBe(true);
    expect(s.eof).toBe(true);
    expect(reduceMpvMessage(s, { event: 'end-file', reason: 'eof' })).toBe(false);
    expect(reduceMpvMessage(s, { event: 'property-change', name: 'time-pos', data: null })).toBe(false);
    expect(reduceMpvMessage(s, { event: 'unknown-event' })).toBe(false);
    expect(reduceMpvMessage(s, null)).toBe(false);
  });

  it('畸形数据不崩、不误写（string/NaN 全忽略）', () => {
    const s = initialKernelState();
    expect(reduceMpvMessage(s, { event: 'property-change', name: 'time-pos', data: 'abc' })).toBe(false);
    expect(reduceMpvMessage(s, { event: 'property-change', name: 'width', data: Number.NaN })).toBe(false);
    expect(reduceMpvMessage(s, { event: 'property-change', name: 'width', data: -3 })).toBe(false);
    expect(s.time).toBeNull();
    expect(s.videoW).toBe(0);
  });
});

describe('mpvCore · 字幕/画面比例换算', () => {
  it('mpvFitProps 默认（contain）保持比例、不覆盖画面比', () => {
    const p = Object.fromEntries(mpvFitProps('contain'));
    expect(p.keepaspect).toBe('yes');
    expect(p['video-aspect-override']).toBe('no');
  });

  it('字号近似 2:1、越界钳制；非法回落 55', () => {
    expect(mpvFontSize(28)).toBe(56);
    expect(mpvFontSize(0)).toBe(55);
    expect(mpvFontSize(Number.NaN)).toBe(55);
    expect(mpvFontSize(9999)).toBe(200);
  });

  it('sub-pos：距底 px → 距顶百分比（越界钳制、非法回落 90）', () => {
    expect(mpvSubPos(0, 800)).toBe(100);
    expect(mpvSubPos(80, 800)).toBe(90);
    expect(mpvSubPos(900, 800)).toBe(0);
    expect(mpvSubPos(10, 0)).toBe(90);
  });
});

describe('mpvCore · mpv.exe 解析链（配置覆盖 → 随包内置 → 本机探测）', () => {
  const env = { ProgramFiles: 'C:\\PF' } as Record<string, string | undefined>;
  const bundled = 'R:\\resources\\mpv\\mpv.exe';

  it('覆盖路径存在 → override 优先', () => {
    const r = resolveMpvPath({ override: 'D:\\my\\mpv.exe', bundled, env, exists: (p) => p === 'D:\\my\\mpv.exe' || p === bundled });
    expect(r).toEqual({ path: 'D:\\my\\mpv.exe', source: 'override' });
  });

  it('覆盖路径不存在/为空 → 落到内置', () => {
    expect(resolveMpvPath({ override: 'D:\\nope.exe', bundled, env, exists: (p) => p === bundled }).source).toBe('bundled');
    expect(resolveMpvPath({ override: '', bundled, env, exists: (p) => p === bundled }).source).toBe('bundled');
  });

  it('内置缺失 → 本机常见安装位置（Program Files\\mpv\\mpv.exe）', () => {
    const r = resolveMpvPath({ bundled, env, exists: (p) => p === 'C:\\PF\\mpv\\mpv.exe' });
    expect(r).toEqual({ path: 'C:\\PF\\mpv\\mpv.exe', source: 'system' });
  });

  it('全部缺失 → none（调用方据此隐藏 MPV 入口）', () => {
    const r = resolveMpvPath({ bundled, env, exists: () => false });
    expect(r).toEqual({ path: '', source: 'none' });
  });

  it('非法路径（exists 抛错）不崩、视为不存在', () => {
    const r = resolveMpvPath({
      override: '?:\\bad',
      bundled,
      env,
      exists: (p) => {
        if (p === '?:\\bad') throw new Error('bad path');
        return true;
      },
    });
    expect(r.source).toBe('bundled');
  });
});