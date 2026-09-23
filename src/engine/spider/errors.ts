// src/engine/spider/errors.ts
// 源"不可用/失败"的类型化原因定义（任务 A1）。
// 统一由上层（SourceViewModel / SpiderHost / ipcGuard）捕获后把 message 展示到 UI，
// 取代"静默返回空 + 只写日志"的旧行为。
export type SourceProblemCode =
  | 'TYPE_UNSUPPORTED' // type=2/4/-1 在桌面版无分发实现
  | 'PY_UNSUPPORTED' // type=3 + api .py（安卓 normal flavor 同为空实现）
  | 'JAR_NO_RUNTIME' // jar(dex) 蜘蛛缺少 JVM 桥运行时
  | 'JAR_DOWNLOAD_FAIL' // jar(dex) 下载/转换失败
  | 'JS_FORMAT_UNSUPPORTED' // JS 蜘蛛导出格式不受支持
  | 'JS_BYTECODE' // QuickJS //bb 字节码，node:vm 无法执行
  | 'NETWORK' // HTTP 网络层失败（超时/非 2xx/连接异常）
  | 'SPIDER_ERROR' // 蜘蛛调用返回了空/非法内容
  | 'EMPTY_RESULT' // 蜘蛛正常返回但确无数据
  | 'NO_SPIDER'; // 找不到对应蜘蛛实例

/** 每个 code 的用户可读中文文案（UI/日志共用，保证提示一致） */
export const SOURCE_PROBLEM_TEXT: Record<SourceProblemCode, string> = {
  TYPE_UNSUPPORTED: '该源类型在桌面版不可用',
  PY_UNSUPPORTED: 'python 源需要嵌入式 CPython3 运行时（缺失或下载失败）',
  JAR_NO_RUNTIME: 'jar(dex) 蜘蛛缺少 JVM 桥运行时',
  JAR_DOWNLOAD_FAIL: 'jar(dex) 蜘蛛下载或转换失败',
  JS_FORMAT_UNSUPPORTED: 'JS 蜘蛛导出格式不受支持',
  JS_BYTECODE: 'JS 蜘蛛为 QuickJS 字节码，桌面版无法执行',
  NETWORK: '网络请求失败',
  SPIDER_ERROR: '蜘蛛返回空结果（可能源站失效或需配置 ext）',
  EMPTY_RESULT: '源暂无数据',
  NO_SPIDER: '未找到对应蜘蛛实现',
};

/** 带 code 的引擎错误：message 必须是人可读中文，随 IPC err 通道上屏 */
export class SourceProblemError extends Error {
  constructor(
    public readonly code: SourceProblemCode,
    msg: string,
    public readonly detail?: unknown,
  ) {
    super(msg || SOURCE_PROBLEM_TEXT[code]);
    this.name = 'SourceProblemError';
  }
}

/**
 * UnsupportedSpider 的 reason（SiteParser/SpiderFactory 使用的旧标识）→ SourceProblemCode。
 * 让"降级蜘蛛"抛错时也能给出精确 code，便于 UI/测试断言。
 */
export function sourceProblemCodeForReason(reason: string | undefined): SourceProblemCode {
  switch (reason) {
    case 'UNSUPPORTED_PY':
      return 'PY_UNSUPPORTED';
    case 'UNSUPPORTED_JAR':
    case 'JAR_NO_RUNTIME':
      return 'JAR_NO_RUNTIME';
    case 'UNSUPPORTED_BYTECODE':
    case 'JS_BYTECODE':
      return 'JS_BYTECODE';
    case 'UNSUPPORTED_FORMAT':
    case 'JS_FORMAT_UNSUPPORTED':
      return 'JS_FORMAT_UNSUPPORTED';
    case 'UNSUPPORTED_PUSH':
      return 'TYPE_UNSUPPORTED';
    default:
      return 'JS_FORMAT_UNSUPPORTED';
  }
}

/** 由 reason 生成"已降级" spider 抛错用的缺省中文（message 缺省时使用） */
export function sourceProblemTextForReason(reason: string | undefined): string {
  return SOURCE_PROBLEM_TEXT[sourceProblemCodeForReason(reason)];
}
