// src/main/util/windowCorner.ts
// Win11 无边框窗口右上角(关闭钮旁)异形修复：
//   无边框 + backgroundMaterial(mica) 时，窗口在「最大化」状态仍保留 Win11 圆角，
//   浏览器视口外的圆角区会露出背景/黑角，视觉上就是「右上角按钮附近异形」。
//   处理：最大化时调用 DWMWA_WINDOW_CORNER_PREFERENCE(=33) 取消圆角，还原时恢复圆角。
import { execFile } from 'node:child_process';
import type { BrowserWindow } from 'electron';

/** 设置窗口圆角：round=true 恢复 Win11 圆角(2)，false 取消(1=donotround) */
export function applyWindowCorner(win: BrowserWindow, round: boolean): void {
  if (process.platform !== 'win32' || win.isDestroyed()) return;
  try {
    const buf = win.getNativeWindowHandle() as Buffer;
    const hwnd = buf.length >= 8
      ? buf.readBigUInt64LE(0).toString()
      : String(buf.readUInt32LE(0));
    const corner = round ? 2 : 1;
    // PowerShell + P/Invoke dwmapi.DwmSetWindowAttribute(hwnd, 33=DWMWA_WINDOW_CORNER_PREFERENCE, ref val, 4)
    // 用 execFile 直接传 argv，不经 shell，避免转义陷阱。
    const code = 'Add-Type -TypeDefinition \'using System;using System.Runtime.InteropServices;' +
      'public static class W{[DllImport("dwmapi.dll")]public static extern int DwmSetWindowAttribute(System.IntPtr h,int a,ref int v,int s);}\';' +
      `$p=[IntPtr][long]${hwnd};$c=${corner};[W]::DwmSetWindowAttribute($p,33,[ref]$c,4)`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], { windowsHide: true }, () => { /* 异步，忽略结果 */ });
  } catch {
    /* 失败静默（不阻塞窗口） */
  }
}