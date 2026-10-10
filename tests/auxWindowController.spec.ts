import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../src/shared/ipc-channels';

const mocks = vi.hoisted(() => ({ windows: [] as any[] }));
vi.mock('electron', () => ({
  app: { isPackaged: true },
  nativeTheme: { shouldUseDarkColors: false },
  shell: { openExternal: vi.fn() },
  BrowserWindow: class {
    destroyed = false;
    minimized = false;
    events = new Map<string, (...args: any[]) => void>();
    webContents = {
      id: mocks.windows.length + 1,
      send: vi.fn(), isLoading: () => false,
      setWindowOpenHandler: vi.fn(), invalidate: vi.fn(),
    };
    show = vi.fn(); focus = vi.fn(); restore = vi.fn();
    loadFile = vi.fn(); loadURL = vi.fn();
    constructor(_options: unknown) { mocks.windows.push(this); }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized; }
    on(event: string, cb: (...args: any[]) => void) { this.events.set(event, cb); }
  },
}));
vi.mock('../src/main/util/windowCorner', () => ({ applyWindowCorner: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  mocks.windows.length = 0;
});

describe.each(['search', 'detail'] as const)('独立 %s 窗口路由交接', (kind) => {
  async function controller() {
    if (kind === 'search') {
      const m = await import('../src/main/player/SearchWindow');
      return { open: (id: string) => m.openSearchWindow(id), ready: m.searchWindowReady };
    }
    const m = await import('../src/main/player/DetailWindow');
    return { open: (id: string) => m.openDetailWindow({ key: 'source', id }), ready: m.detailWindowReady };
  }
  it('加载期间连续打开只创建一个窗口，订阅后收到最新目标', async () => {
    const c = await controller();
    expect(c.open('first').reused).toBe(false);
    expect(c.open('latest%2F').reused).toBe(true);
    expect(mocks.windows).toHaveLength(1);
    const w = mocks.windows[0];
    expect(w.webContents.send).not.toHaveBeenCalled();
    c.ready(w.webContents.id);
    expect(w.webContents.send).toHaveBeenLastCalledWith(IPC.WIN_NAVIGATE, expect.stringContaining('latest%252F'));
  });
  it('无关窗口不能标记 ready；hash 导航不抹掉已就绪状态', async () => {
    const c = await controller();
    c.open('first');
    const w = mocks.windows[0];
    c.ready(w.webContents.id + 100);
    expect(w.webContents.send).not.toHaveBeenCalled();
    c.ready(w.webContents.id);
    w.events.get('did-start-loading')?.();
    c.open('second');
    expect(w.webContents.send).toHaveBeenLastCalledWith(IPC.WIN_NAVIGATE, expect.stringContaining('second'));
  });
  it('最小化窗口可复用；关闭后重新创建并等候订阅', async () => {
    const c = await controller();
    c.open('first');
    const w = mocks.windows[0];
    w.minimized = true;
    c.open('second');
    expect(w.restore).toHaveBeenCalledOnce();
    w.destroyed = true;
    w.events.get('closed')?.();
    expect(c.open('third').reused).toBe(false);
    expect(mocks.windows).toHaveLength(2);
    expect(mocks.windows[1].webContents.send).not.toHaveBeenCalled();
  });
});
