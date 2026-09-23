# -*- coding: utf-8 -*-
# PythonRunner 的 CPython3 等价实现（桌面版 .py 蜘蛛运行时）。
#
# argv 契约与 resources/jvm/PythonRunner.java 完全一致（供 JarSpiderBridge.callPython 复用解析）：
#   runner.py <pyPath> <className> <method> [ext] [args...]
#    - argv[0] 一定是本脚本的绝对路径（spawn python.exe runner.py ...）
#    - [ext] 喂给 init()（首个可调用实参，可缺省）
#    - 之后按方法签名取实参（categoryContent/detailContent/searchContent/playerContent 等）
#
# 输出协议（与 Jython 版一致，bridge 的 extractSpiderReason / [SpiderRunner.ERROR] 提取零改动）：
#   - 正常：结果 json.dumps 到 stdout
#   - 失败：`[SpiderRunner.ERROR] <type>: <msg>` + traceback 到 stderr，退出码 1
#
# ★ 嵌入式 Python（python-3.11.x-embed-amd64）的 python311._pth 是只读隔离的：
#   不加载 site-packages、忽略 PYTHONPATH。因此这里**必须**用绝对路径手动注入 sys.path：
#   [pythonDir/Lib, pythonDir/Lib/site-packages, runnerDir/base, 脚本所在目录]
#   （pythonDir = runner.py 所在目录；embed 包结构为 python.exe + python311.zip + Lib/）。

import json
import os
import sys
import traceback

# ---- 1. sys.path 注入（必须在 import 第三方库/脚本之前） ----
def _dir_of(p):
    return os.path.dirname(os.path.abspath(p))

RUNNER_DIR = _dir_of(sys.argv[0])
PY_DIR = RUNNER_DIR  # embed 包：runner.py 与 python.exe 同目录
# runner 落盘目录即为 embed 根目录（python.exe + python311.zip + Lib/ + base/ 同层），
# 因此把 PY_DIR 本身加入 sys.path 即可让 `import base.spider`（base/ 子目录）命中；
# Lib 与 site-packages 也一并显式注入（embed 的 _pth 隔离不自动加载）。
for _p in [
    PY_DIR,
    os.path.join(PY_DIR, 'Lib'),
    os.path.join(PY_DIR, 'Lib', 'site-packages'),
]:
    if os.path.isdir(_p) and _p not in sys.path:
        sys.path.insert(0, _p)


def _fail(err):
    sys.stderr.write('[SpiderRunner.ERROR] %s: %s\n' % (type(err).__name__, err))
    traceback.print_exc(file=sys.stderr)
    sys.exit(1)


def _invoke(sp, name, *args):
    fn = getattr(sp, name, None)
    if fn is None:
        raise AttributeError('method not found: %s' % name)
    return fn(*args)


def main():
    if len(sys.argv) < 3:
        raise SystemExit('usage: runner.py <pyPath> <className> <method> [ext] [args...]')
    py_path = sys.argv[1]
    class_name = sys.argv[2]
    method = sys.argv[3]
    ext = sys.argv[4] if len(sys.argv) > 4 else ''

    # 脚本目录（含 base 包查找兜底：部分脚本 sys.path.append('..') 依赖运行目录，这里显式补一次）
    script_dir = _dir_of(py_path)
    if script_dir not in sys.path:
        sys.path.insert(0, script_dir)

    ns = {}
    with open(py_path, 'r', encoding='utf-8') as f:
        src = f.read()
    exec(compile(src, py_path, 'exec'), ns)

    cls = ns.get(class_name)
    if cls is None:
        raise SystemExit('Python 类不存在: %s' % class_name)
    sp = cls()

    # init(ext) no-op 容错（部分脚本不实现 init）
    try:
        sp.init(ext)
    except (AttributeError, TypeError):
        pass

    # 方法分派（对齐 Jython PythonRunner.java）
    if method == 'homeContent':
        result = _invoke(sp, 'homeContent', True)
    elif method == 'homeVideoContent':
        result = _invoke(sp, 'homeVideoContent')
    elif method == 'categoryContent':
        tid = sys.argv[5] if len(sys.argv) > 5 else ''
        pg = sys.argv[6] if len(sys.argv) > 6 else '1'
        extend = sys.argv[7] if len(sys.argv) > 7 else '{}'
        try:
            extend_obj = json.loads(extend) if extend else {}
        except (ValueError, TypeError):
            extend_obj = {}
        result = _invoke(sp, 'categoryContent', tid, (pg or '1'), True, extend_obj)
    elif method == 'detailContent':
        ids = sys.argv[5] if len(sys.argv) > 5 else '[]'
        try:
            ids_obj = json.loads(ids) if ids else []
        except (ValueError, TypeError):
            ids_obj = []
        result = _invoke(sp, 'detailContent', ids_obj)
    elif method == 'searchContent':
        key = sys.argv[5] if len(sys.argv) > 5 else ''
        pg = sys.argv[7] if len(sys.argv) > 7 else ''
        if pg and pg.strip():
            # 3 参签名优先；脚本无 3 参签名则回退 2 参
            try:
                result = _invoke(sp, 'searchContent', key, False, pg)
            except TypeError:
                result = _invoke(sp, 'searchContent', key, False)
        else:
            result = _invoke(sp, 'searchContent', key, False)
    elif method == 'playerContent':
        flag = sys.argv[5] if len(sys.argv) > 5 else ''
        pid = sys.argv[6] if len(sys.argv) > 6 else ''
        vip = sys.argv[7] if len(sys.argv) > 7 else '[]'
        try:
            vip_obj = json.loads(vip) if vip else []
        except (ValueError, TypeError):
            vip_obj = []
        result = _invoke(sp, 'playerContent', flag, pid, vip_obj)
    elif method == 'liveContent':
        result = _invoke(sp, 'liveContent', sys.argv[5] if len(sys.argv) > 5 else '')
    elif method == 'proxy':
        result = _invoke(sp, 'proxy', sys.argv[5] if len(sys.argv) > 5 else '{}')
    else:
        raise SystemExit('unknown method: %s' % method)

    # 结果序列化：dict/list → json；蜘蛛已自行返回 JSON 字符串则原样透传
    out = result
    if isinstance(out, str):
        try:
            parsed = json.loads(out)
            json.dumps(parsed)  # 校验可解析
            out = parsed
        except (ValueError, TypeError):
            pass  # 非 JSON 字符串，交给 dumps 兜底
    sys.stdout.write(json.dumps(out, ensure_ascii=False) if not isinstance(out, str) else out)
    sys.stdout.write('\n')


if __name__ == '__main__':
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        _fail(e)