// src/engine/util/regex.ts
// ★ 上游正则常量集中地（唯一来源，禁止散落到业务文件）。
// 所有正则来自 ref2/app__src__main__java__com__github__tvbox__osc__util__live__TxtSubscribe.java，
// 注释标注出处行号。任何解析改动必须配黄金用例。

// TxtSubscribe.java:20  频道名取"最后一个逗号之后" → 安卓既有行为，刻意复刻，勿修正
export const NAME_PATTERN = /.*,(.+?)$/;

// TxtSubscribe.java:21  group-title="..."
export const GROUP_PATTERN = /group-title="(.*?)"/;

// TxtSubscribe.java:22-29
export const TVG_CHNO_PATTERN = /tvg-chno="(.*?)"/;
export const TVG_LOGO_PATTERN = /tvg-logo="(.*?)"/;
export const TVG_NAME_PATTERN = /tvg-name="(.*?)"/;
// ★★ 注意：TVG_URL_PATTERN = tvg-url="(.*?)" 无锚点 → 对 `x-tvg-url="..."` 子串命中。
// 安卓既有行为（"bug"），刻意复刻，勿修正，否则与安卓输出不一致。
export const TVG_URL_PATTERN = /tvg-url="(.*?)"/;
export const TVG_ID_PATTERN = /tvg-id="(.*?)"/;
export const HTTP_USER_AGENT_PATTERN = /http-user-agent="(.*?)"/;
export const CATCHUP_PATTERN = /catchup="(.*?)"/;
export const CATCHUP_SOURCE_PATTERN = /catchup-source="(.*?)"/;
export const CATCHUP_REPLACE_PATTERN = /catchup-replace="(.*?)"/;

/** 应用一个正则取第 1 组，未命中返回 ""（等价 TxtSubscribe.get(line, pattern)） */
export function firstGroup(line: string, pattern: RegExp): string {
  const m = line.match(pattern);
  return m && m[1] ? m[1].trim() : '';
}
