// src/shared/ipc-result.ts
export interface IpcOk<T> {
  ok: true;
  data: T;
}
export interface IpcErr {
  ok: false;
  error: { code: string; message: string; detail?: unknown };
}
export type IpcResult<T> = IpcOk<T> | IpcErr;

export const ok = <T>(data: T): IpcOk<T> => ({ ok: true, data });
export const err = (code: string, message: string, detail?: unknown): IpcErr => ({
  ok: false,
  error: { code, message, detail },
});
