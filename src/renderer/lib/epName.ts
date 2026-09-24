// src/renderer/lib/epName.ts
// ★ 2026-09-24 剧集名展示归一（详情页选集 / 播放器标题 / 历史记录共用）：
//   网盘源（夸克/UC 转存）的「集名」其实是一整串文件名，例如
//     `[740.08MB] T:提供 迪迦奥特曼.S01E01.2160p.WEB-DL.HDR.mkv`
//   直接渲染会把按钮撑成一长条、什么都看不清。这里统一压成 **「第N集 · 文件大小」**：
//     · 体积优先取 `[740.08MB]` 这类方括号标签；没有则用文件名里的体积串；
//     · 集号优先取 `S01E03 / EP03 / 第3集`；取不到就用列表下标 +1（网盘转存正是按集顺序排列）；
//     · **只对「文件名式」集名生效**（带体积标签 / 带视频扩展名 / 过长）；像「第01集」「01」这类
//       本来干净的集名原样保留，避免改变 CMS 源的观感。
const SIZE_BRACKET = /\[\s*([\d.]+\s*(?:TB|GB|MB|KB|B))\s*\]/i;
/** 文件名里的体积串：必须从数字起（避免把 `WEB-DL.1.4GB` 里的 `.` 一起吃进来 → ".1.4GB"） */
const SIZE_ANY = /(\d+(?:\.\d+)?\s*(?:TB|GB|MB|KB))/i;
const EP_NO = /(?:[Ss]\d{1,2})?[Ee][Pp]?\s*0*(\d{1,4})|第\s*0*(\d{1,4})\s*[集话話]/;
const FILE_EXT = /\.(?:mkv|mp4|ts|m2ts|avi|rmvb|flv|mov|wmv|webm)\b/i;
/** 「文件名式」判定：过长（>28 字符）或带体积标签或带视频扩展名 */
const FILEISH_LEN = 28;

/** 归一后的集名（空名 → `第N集`） */
export function formatEpisodeLabel(name: string, index: number): string {
  const raw = (name || '').trim();
  const bracket = raw.match(SIZE_BRACKET)?.[1];
  const looksFile = !!bracket || FILE_EXT.test(raw) || raw.length > FILEISH_LEN;
  if (!looksFile) return raw || `第${index + 1}集`;
  const size = (bracket || raw.match(SIZE_ANY)?.[1] || '').replace(/\s+/g, '');
  const m = EP_NO.exec(raw);
  const parsed = m ? Number(m[1] ?? m[2]) : 0;
  const no = parsed > 0 ? parsed : index + 1;
  return `第${no}集${size ? ` · ${size}` : ''}`;
}