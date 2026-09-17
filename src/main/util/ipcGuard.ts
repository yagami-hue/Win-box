// src/main/util/ipcGuard.ts — 统一 try/catch 包装 IPC handler，异常转 IpcResult.error
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { ok, err, type IpcResult } from '../../shared/ipc-result';
import type { Logger } from '../../shared/types';

export function registerHandler<T>(
  channel: string,
  handler: (e: IpcMainInvokeEvent, ...args: any[]) => Promise<T> | T,
  logger: Logger,
): void {
  ipcMain.handle(channel, async (e, ...args): Promise<IpcResult<T>> => {
    try {
      const data = await handler(e, ...args);
      return ok(data);
    } catch (err2) {
      const msg = err2 instanceof Error ? err2.message : String(err2);
      logger.e(`ipc ${channel} 失败: ${msg}`, err2 instanceof Error ? err2 : undefined);
      return err('HANDLER_ERROR', msg);
    }
  });
}
