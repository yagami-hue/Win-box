// src/engine/vod/sourceAvailability.ts
// 纯函数：判断一条源在桌面版"是否可用 / 若不可用给出人读中文 hint"。
// 任务 A2：规则固化到单一函数，UI（HomePage/ConfigPage）与后端 type 分发共用同一套文案，
// 避免"下拉显示可用/状态 OK"却点开才报错的自相矛盾。
//
// 注意：本文件必须保持零 Node 依赖（纯 TS），供 renderer 直接 import（会被打进 web bundle）。
import type { SourceBean } from '../../shared/types';
import { SOURCE_PROBLEM_TEXT } from '../spider/errors';

export interface SourceAvailability {
  usable: boolean;
  hint?: string;
}

export interface SourceAvailabilityOptions {
  /** python 蜘蛛 Jython 宿主是否可用（缺省 true）。false 时 .py 源报 PY_UNSUPPORTED。 */
  pythonAvailable?: boolean;
}

/**
 * usable = type ∈ {0,1,4,3(.js/.jar)}；
 *   type=3 的 .py 需 Jython 宿主；csp_/jar(dex) 有 JVM 桥运行时兜底。
 * type 2 为安卓保留/未知值（上游无分发分支）、-1 为推送源（依赖外部推送）→ 均不可用并给中文 hint。
 */
export function sourceAvailability(
  bean: Pick<SourceBean, 'type' | 'api'>,
  opts?: SourceAvailabilityOptions,
): SourceAvailability {
  const type = bean?.type;
  const pythonAvailable = opts?.pythonAvailable ?? true;
  if (type === 0 || type === 1 || type === 4) {
    // type 4 = 苹果 CMS JSON 变体（推送 detail）：与 type 1 同为 JSON，走 CmsSource（ac=detail）。
    return { usable: true };
  }
  if (type === 3) {
    const low = String(bean.api || '').toLowerCase();
    if (low.endsWith('.py')) {
      if (!pythonAvailable) {
        return { usable: false, hint: SOURCE_PROBLEM_TEXT.PY_UNSUPPORTED };
      }
      return { usable: true };
    }
    return { usable: true };
  }
  if (type === 2) {
    return { usable: false, hint: 'type=2 为安卓保留/未知值，上游无分发分支，桌面版同为空' };
  }
  if (type === -1) {
    return { usable: false, hint: 'type=-1 为推送源，需外部设备推送 URL，桌面版无推送接收端' };
  }
  return { usable: false, hint: `type=${type} 为未知类型，桌面版不可用` };
}
