// src/renderer/lib/externalPlay.ts
// ★ 2026-09-30（用户要求）：**显式绑定第三方播放器时，点播直接由外部播放器播放**（不启动内置播放器窗口）。
//
// 语义（用户原话「不要在内置播放器中跳转第三方播放器，如果在设置中选定了第三方播放器，
//   应直接由第三方播放器播放，不启动内置播放器」）：
//   · 只有 `vodExternalPlayer` **显式绑定**（非空）才改道外部；留空 = 继续用内置播放器（保持旧行为）；
//   · 改道前必须先解析出可播地址（`client.play`）—— 解析不出（需网页解析 / 需网盘绑定）时**回退内置播放器**，
//     由内置播放器窗口上屏原因（否则用户只看到「点了没反应」）；
//   · 图集（image）与桌面无载体协议（unsupported）不改道 —— 内置播放器有对应的专用界面与提示。
//
// 历史（用户要求「第三方播放器应也能正常保存历史记录 + 从历史启动要能识别历史播放的位置」）：
//   · 拉起成功后照常 `recordWatch`（**不带 time**：外部播放器无法回传进度，保留上次已知位置而不是归零）；
//   · `seek`（起播秒数）由调用方给出：历史页 = 该条记录的 time；详情页 = 同集已有进度（`uiMemory.sameEpProgress`）。
import { client } from '../api/client';
import { detectMediaKind } from './mediaKind';
import { recordWatch, saveUiMemory } from './uiMemory';

export interface VodExternalPlayInput {
  /** 源 key（重新解析/记历史用） */
  key: string;
  /** 播放源 flag */
  flag: string;
  /** 原始 episode url（**记历史与重新解析都用它**，直链可能过期） */
  rawUrl: string;
  /** 展示名（剧名 - 集名） */
  display: string;
  pic?: string;
  remarks?: string;
  sourceName?: string;
  vodId?: string;
  /** 起播位置（秒）：>0 时按播放器类型拼命令行参数 */
  seek?: number;
}

export interface VodExternalOutcome {
  /** true = 已交给外部播放器（调用方**不要**再开内置播放器窗口） */
  played: boolean;
  /** 实际启动的播放器名（played=true 时） */
  player?: string;
}

/**
 * 尝试用外部播放器直接播放。
 * @returns played=false → 调用方照旧走内置播放器窗口（未绑定 / 解析不出 / 启动失败）。
 */
export async function playVodExternal(a: VodExternalPlayInput): Promise<VodExternalOutcome> {
  let bound = '';
  try {
    const prefs = await client.playerPrefsGet();
    bound = (prefs?.vodExternalPlayer || '').trim();
  } catch {
    return { played: false }; // 读偏好失败：保守走内置播放器
  }
  if (!bound) return { played: false };
  const rawUrl = (a.rawUrl || '').trim();
  if (!rawUrl) return { played: false };
  let r: { url?: string; parse?: number; needDriveCookieBind?: string };
  try {
    r = await client.play({ key: a.key, flag: a.flag, id: rawUrl });
  } catch {
    return { played: false }; // 解析失败：交给内置播放器窗口显示原因
  }
  const url = (r?.url || '').trim();
  if (!url || r.parse === 1 || r.needDriveCookieBind) return { played: false };
  const kind = detectMediaKind(url);
  if (kind === 'image' || kind === 'unsupported') return { played: false };
  try {
    const res = await client.vodOpenExternal(url, undefined, a.seek);
    if (!res?.ok) return { played: false };
    // 记录观看历史（不带 time：外部播放器不回传进度，保留上次已知位置）
    recordWatch({
      url: rawUrl,
      rawUrl,
      flag: a.flag,
      name: a.display,
      pic: a.pic,
      remarks: a.remarks,
      sourceName: a.sourceName,
      sourceKey: a.key,
      vodId: a.vodId,
    });
    saveUiMemory(); // 立即落盘：历史页/主窗口靠读 localStorage 同步
    return { played: true, player: res.player };
  } catch {
    return { played: false };
  }
}