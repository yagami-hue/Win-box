import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/util/paths', () => ({ cacheDir: () => '.', resourcesDir: () => '.' }));
vi.mock('../src/main/player/playerSettings', () => ({ playerSettings: { settings: {} } }));
vi.mock('../src/main/player/PlayerWindow', () => ({ playerIsMini: () => false, playerIsFullscreen: () => false }));
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
import { spawn } from 'node:child_process';
import { MpvController } from '../src/main/player/MpvController';

class Proc extends EventEmitter {
  exitCode: number | null = null;
  signalCode = null;
  killed = false;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill() { this.killed = true; this.finish(); }
  finish() { this.exitCode = 0; this.emit('exit', 0); }
}
class Sock extends EventEmitter {
  write = vi.fn();
  end = vi.fn();
  destroy = vi.fn();
}
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const windowStub = () => Object.assign(new EventEmitter(), {
  isDestroyed: () => false,
  isFullScreen: () => false,
  getContentBounds: () => ({ height: 600 }),
  getNativeWindowHandle: () => Buffer.from([1, 0, 0, 0]),
  webContents: { send: vi.fn(), invalidate: vi.fn() },
});
const make = () => {
  const controller = new MpvController({ i: vi.fn(), w: vi.fn(), e: vi.fn() });
  vi.spyOn(controller, 'status').mockReturnValue({ available: true, path: 'mpv.exe', source: 'bundled', note: '' });
  const sockets: Sock[] = [];
  vi.spyOn(controller as any, 'connectPipe').mockImplementation(async () => {
    const socket = new Sock(); sockets.push(socket); return socket;
  });
  return { controller, sockets };
};

beforeEach(() => vi.clearAllMocks());
describe('mpv lifecycle', () => {
  it('a stop cancels a start still waiting in the queue', async () => {
    const { controller } = make();
    const pending = controller.start(windowStub() as any, { url: 'a.mp4' });
    controller.stop();
    await pending;
    expect(spawn).not.toHaveBeenCalled();
  });
  it('only the latest concurrent start spawns', async () => {
    const { controller, sockets } = make();
    const proc = new Proc(); vi.mocked(spawn).mockReturnValue(proc as any);
    const win = windowStub();
    await Promise.all([controller.start(win as any, { url: 'old.mp4' }), controller.start(win as any, { url: 'new.mp4', volume: .6 })]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(sockets[0].write.mock.calls.flat().join('')).toContain('new.mp4');
    expect(sockets[0].write.mock.calls.flat().join('')).not.toContain('old.mp4');
    proc.finish(); controller.stop();
  });
  it('waits for the old process to release its HWND and ignores its late messages', async () => {
    const { controller, sockets } = make();
    const oldProc = new Proc(), newProc = new Proc();
    vi.mocked(spawn).mockReturnValueOnce(oldProc as any).mockReturnValueOnce(newProc as any);
    const win = windowStub();
    await controller.start(win as any, { url: 'old.mp4' });
    const next = controller.start(win as any, { url: 'new.mp4', paused: true });
    await tick();
    expect(spawn).toHaveBeenCalledTimes(1);
    oldProc.finish();
    await next;
    expect(spawn).toHaveBeenCalledTimes(2);
    sockets[0].emit('data', Buffer.from('{"event":"property-change","name":"time-pos","data":99}\n'));
    expect((controller as any).state.time).toBeNull();
    const lines = sockets[1].write.mock.calls.flat().join('');
    expect(lines).toContain('"mute","no"');
    expect(lines).toContain('"pause","yes"');
    newProc.finish(); controller.stop();
    expect(win.listenerCount('resize')).toBe(0);
  });
});
