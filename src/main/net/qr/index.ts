// src/main/net/qr/index.ts — 扫码 provider 适配层注册表（任务 B）。
import type { DriveProvider, DriveQrAdapter } from './types';
import { aliAdapter, alipanAdapter } from './ali';
import { quarkAdapter } from './quark';
import { ucAdapter } from './uc';

export type { DriveProvider, DriveQrAdapter, QrPollResult, QrSession } from './types';

/** 支持扫码的 provider（UI 门槛 / 校验共用唯一来源） */
export const QR_SUPPORTED_PROVIDERS: readonly DriveProvider[] = ['ali', 'alipan', 'quark', 'uc'];

const REGISTRY: Record<DriveProvider, DriveQrAdapter> = {
  ali: aliAdapter,
  alipan: alipanAdapter,
  quark: quarkAdapter,
  uc: ucAdapter,
};

/** 是否支持扫码 */
export function isQrSupported(provider: string): provider is DriveProvider {
  return (QR_SUPPORTED_PROVIDERS as readonly string[]).includes(provider);
}

/** 取适配器；未知 provider 抛可读错误（默认 ali，保持旧调用兼容） */
export function getAdapter(provider: string): DriveQrAdapter {
  const p = (provider || 'ali').toLowerCase() as DriveProvider;
  const adapter = REGISTRY[p];
  if (!adapter) {
    throw new Error(`不支持的扫码网盘 provider：${provider || '(空)'}（支持：${QR_SUPPORTED_PROVIDERS.join(' / ')}）`);
  }
  return adapter;
}
