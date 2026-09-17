// src/shared/constants.ts
// 默认值集中地。与安卓 ApiConfig / DefaultConfig 对齐。

export const LOCAL_PROXY_HOST = '127.0.0.1';
export const LOCAL_PROXY_PORT = 9978; // 与安卓同端口同路由 do=live&type=txt&ext=
export const LOCAL_PROXY_BASE = `http://${LOCAL_PROXY_HOST}:${LOCAL_PROXY_PORT}`;
export const LIVE_PROXY_ROUTE = `${LOCAL_PROXY_BASE}/proxy?do=live&type=txt&ext=`;

export const DEFAULT_GROUP_NAME = '直播';
export const LEGACY_DEFAULT_GROUP_NAME = 'Ungrouped';
export const DEFAULT_CHANNEL_NAME = 'Unnamed';

// 超时 clamp（秒）—— 对齐安卓
export const SITE_TIMEOUT_DEFAULT = 15;
export const SITE_TIMEOUT_MIN = 5;
export const SITE_TIMEOUT_MAX = 60;
export const LIVE_TIMEOUT_MIN = 5;
export const LIVE_TIMEOUT_MAX = 30;

// 数值布尔默认值（用 0/1 数字，非 boolean）
export const DEFAULT_SEARCHABLE = 1;
export const DEFAULT_QUICK_SEARCH = 1;
export const DEFAULT_CHANGEABLE = 1;
export const DEFAULT_FILTERABLE = 1;
export const DEFAULT_PLAYER_TYPE = -1;

// 内置"超级解析"约定（type=4，自动插到 parses 列表首位）
export const SUPER_PARSE_NAME = '超级解析';
export const SUPER_PARSE_URL = 'http://127.0.0.1:9978/jiexi?url=';
export const SUPER_PARSE_TYPE = 4;
