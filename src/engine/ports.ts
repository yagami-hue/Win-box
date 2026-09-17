// src/engine/ports.ts
// 宿主能力接口：引擎层从这里取依赖，禁止 import electron。
// T04 由主进程注入实现；T02 单测注入内存桩。
export type {
  HttpClient,
  HttpRequest,
  HttpResponse,
  KVStore,
  Logger,
} from '../shared/types';

export interface EngineHost {
  http: import('../shared/types').HttpClient;
  kv: import('../shared/types').KVStore;
  logger: import('../shared/types').Logger;
  /** 本地代理对外 base，用于 lives 归一化（默认 127.0.0.1:9978） */
  proxyBase?: string;
  /** resources/js-lib 目录（cheerio/模板/gbk/cat 等本地库）；引擎层禁 import electron，目录由宿主传入 */
  jsLibDir?: string;
  /** 可选同步 HTTP（T03-B 沙箱 req() 同步语义的测试 mock 注入点；生产由沙箱内 spawnSync 兜底） */
  httpSync?: (req: import('../shared/types').HttpRequest) => import('../shared/types').HttpResponse;
  /**
   * 网盘/资源站绑定凭据提供器（provider -> token，如 aliyun/quark/uc/baidu/pansou）。
   * 由宿主（SpiderHost）注入 DriveStore 快照；jar(dex) 蜘蛛 init(Context, ext) 前
   * 引擎会把这里返回的 token 并入 ext 顶层，使"先绑网盘 → 蜘蛛读 ext 调盘内资源"
   * 的流程成立（对齐 catvod 系：蜘蛛在 ext 中读取各自约定的 token 键）。
   * 纯内存、可缺省（未实现绑定的宿主不受影响）。
   */
  driveTokens?: () => Record<string, string>;
}
