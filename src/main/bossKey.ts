// src/main/bossKey.ts
// 老板键：全局快捷键 → 一键隐藏所有窗口（任务栏图标消失）+ 通知渲染层暂停并静音；
// 再次按下 → 恢复各窗口原可见性，渲染层恢复音量/播放状态（正常窗口正常、小窗口恢复小窗口）。
import { globalShortcut, type BrowserWindow } from 'electron';
import { join } from 'node:path';
import { JsonStore } from './store/JsonStore';
import { userDataDir } from './util/paths';
import type { BossKeySettings } from '../shared/types';

/** 默认老板键：Ctrl/Cmd + Shift + B */
export const BOSS_DEFAULT_ACCEL = 'CommandOrControl+Shift+B';

export class BossKeyManager {
  private store: JsonStore;
  private getWindows: () => BrowserWindow[] = () => [];
  private active = false; // 当前是否处于「老板模式」（所有窗口已隐藏）
  private registered = false;

  constructor() {
    this.store = new JsonStore(join(userDataDir(), 'bosskey.json'));
  }

  get settings(): BossKeySettings {
    const s = this.store.getObject<BossKeySettings>('bosskey', { enabled: false, accel: BOSS_DEFAULT_ACCEL });
    const accel = (s.accel || '').trim() || BOSS_DEFAULT_ACCEL;
    return { enabled: !!s.enabled, accel };
  }

  set settings(v: BossKeySettings) {
    this.store.setObject('bosskey', { enabled: !!v.enabled, accel: (v.accel || '').trim() || BOSS_DEFAULT_ACCEL });
  }

  get isActive(): boolean {
    return this.active;
  }

  /** 注入窗口获取器（主窗口 + 播放器窗口），app ready 后调用一次即可 */
  start(getWindows: () => BrowserWindow[]): void {
    this.getWindows = getWindows;
  }

  /** 按当前设置注册/注销全局快捷键。返回是否注册成功（未启用恒为 true） */
  apply(): boolean {
    if (this.registered) {
      try {
        globalShortcut.unregisterAll();
      } catch {
        /* ignore */
      }
      this.registered = false;
    }
    if (!this.settings.enabled) return true;
    const accel = this.settings.accel;
    if (!accel) return true;
    try {
      const ok = globalShortcut.register(accel, () => this.toggle());
      if (!ok) return false;
      this.registered = true;
      return true;
    } catch {
      return false;
    }
  }

  toggle(): void {
    if (this.active) this.exit();
    else this.enter();
  }

  /** 进入老板模式：隐藏全部窗口（含播放器窗口；小窗态保留下次恢复）+ 通知暂停静音 */
  enter(): void {
    this.active = true;
    const ws = this.getWindows().filter((w) => !w.isDestroyed());
    for (const w of ws) w.hide();
    for (const w of ws) w.webContents.send('boss:enter');
  }

  /** 退出老板模式：恢复全部窗口 + 通知渲染层恢复播放状态 */
  exit(): void {
    this.active = false;
    const ws = this.getWindows().filter((w) => !w.isDestroyed());
    for (const w of ws) {
      try {
        w.show();
      } catch {
        /* ignore */
      }
    }
    for (const w of ws) w.webContents.send('boss:exit');
  }
}

/** 全局单例（模块级）：IPC 与主进程共用 */
export const bossKey = new BossKeyManager();