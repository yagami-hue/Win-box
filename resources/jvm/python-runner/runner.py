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

# ★ stdout 专供「结果/信封」：蜘蛛自己的 print()（base.spider.log 等）会与结果/信封
#   拼进同一行 → 宿主侧按行分帧解析失败 → 常驻池挂起到超时（用户侧「半天搜不出来」）。
#   这里先抓住真正的 stdout 句柄，main() 里再把 sys.stdout 换成 stderr。
_REAL_OUT = sys.stdout


def _fail(err):
    sys.stderr.write('[SpiderRunner.ERROR] %s: %s\n' % (type(err).__name__, err))
    traceback.print_exc(file=sys.stderr)
    sys.exit(1)


def _invoke(sp, name, *args):
    fn = getattr(sp, name, None)
    if fn is None:
        raise AttributeError('method not found: %s' % name)
    return fn(*args)


def _load_script(py_path):
    """读取并编译 py 脚本一次，返回其模块命名空间（脚本目录注入 sys.path）。"""
    script_dir = _dir_of(py_path)
    if script_dir not in sys.path:
        sys.path.insert(0, script_dir)
    ns = {}
    with open(py_path, 'r', encoding='utf-8') as f:
        src = f.read()
    exec(compile(src, py_path, 'exec'), ns)
    return ns


def _new_instance(ns, class_name):
    cls = ns.get(class_name)
    if cls is None:
        raise SystemExit('Python 类不存在: %s' % class_name)
    return cls()


def _call_method(sp, method, rest):
    """方法分派（对齐 Jython PythonRunner.java）。rest 为实参数组（下标 0 起即方法参数，与 argv 中 [ext] 之后对齐）。"""
    if method == 'homeContent':
        return _invoke(sp, 'homeContent', True)
    if method == 'homeVideoContent':
        return _invoke(sp, 'homeVideoContent')
    if method == 'categoryContent':
        tid = rest[0] if len(rest) > 0 else ''
        pg = rest[1] if len(rest) > 1 else '1'
        extend = rest[2] if len(rest) > 2 else '{}'
        try:
            extend_obj = json.loads(extend) if extend else {}
        except (ValueError, TypeError):
            extend_obj = {}
        return _invoke(sp, 'categoryContent', tid, (pg or '1'), True, extend_obj)
    if method == 'detailContent':
        ids = rest[0] if len(rest) > 0 else '[]'
        try:
            ids_obj = json.loads(ids) if ids else []
        except (ValueError, TypeError):
            ids_obj = []
        return _invoke(sp, 'detailContent', ids_obj)
    if method == 'searchContent':
        key = rest[0] if len(rest) > 0 else ''
        pg = rest[2] if len(rest) > 2 else ''
        if pg and pg.strip():
            try:
                return _invoke(sp, 'searchContent', key, False, pg)
            except TypeError:
                return _invoke(sp, 'searchContent', key, False)
        return _invoke(sp, 'searchContent', key, False)
    if method == 'playerContent':
        flag = rest[0] if len(rest) > 0 else ''
        pid = rest[1] if len(rest) > 1 else ''
        vip = rest[2] if len(rest) > 2 else '[]'
        try:
            vip_obj = json.loads(vip) if vip else []
        except (ValueError, TypeError):
            vip_obj = []
        return _invoke(sp, 'playerContent', flag, pid, vip_obj)
    if method == 'liveContent':
        return _invoke(sp, 'liveContent', rest[0] if len(rest) > 0 else '')
    if method == 'proxy':
        return _invoke(sp, 'proxy', rest[0] if len(rest) > 0 else '{}')
    raise SystemExit('unknown method: %s' % method)


def _serialize(result, real_out=_REAL_OUT):
    """结果序列化：dict/list → json；已 JSON 字符串原样透传；末尾换行。

    ★ 一律写 real_out（真正的 stdout 句柄）：蜘蛛自己的 print() 已被重定向到 stderr
    （见 main），否则它的日志碎片会与结果/信封拼成同一行 → 宿主侧 JSON 解析失败 →
    常驻池挂起到超时（用户侧表现「半天搜不出来」）。
    """
    out = result
    if isinstance(out, str):
        try:
            parsed = json.loads(out)
            json.dumps(parsed)  # 校验可解析
            out = parsed
        except (ValueError, TypeError):
            pass  # 非 JSON 字符串，交给 dumps 兜底
    real_out.write(json.dumps(out, ensure_ascii=False) if not isinstance(out, str) else out)
    real_out.write('\n')
    real_out.flush()


def _serve(py_path, class_name):
    """常驻模式：脚本只编译一次，stdin 逐行读 JSON 请求 {id, method, args}，单行 JSON 信封应答。
    每请求 new Spider 实例（复用 Python 进程、不复用实例，避免跨请求状态串扰）；init(ext) 每请求执行。
    信封：{"id": ..., "ok": true|false, "data": "结果(JSON字符串)"} —— data 经 json.dumps 转义内嵌换行，
    物理单行，行协议不被结果内容打穿。读到 EOF 或请求体 {"quit":true} 退出。
    """
    ns = _load_script(py_path)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = ''
        ok = False
        data = ''
        try:
            req = json.loads(line)
            if not isinstance(req, dict):
                raise ValueError('bad request: %r' % line)
            if req.get('quit'):
                break
            req_id = str(req.get('id', ''))
            method = str(req.get('method', ''))
            args = req.get('args') or []
            if not isinstance(args, list):
                args = [args]
            rest = [str(a) for a in args]
            # ★ 预热探针（池 warm）：脚本已在 _serve 入口编译完成，无需实例化蜘蛛
            if method == '__ping__':
                ok = True
                data = ''
            else:
                sp = _new_instance(ns, class_name)
                ext = rest[0] if len(rest) > 0 else ''
                try:
                    sp.init(ext)
                except (AttributeError, TypeError):
                    pass
                data = _serialize_raw(_call_method(sp, method, rest[1:] if len(rest) > 1 else []))
                ok = True
        except SystemExit as e:
            data = 'SystemExit: %s' % e
        except Exception as e:
            data = '%s: %s' % (type(e).__name__, e)
        # ★ 单行 JSON 信封（data 内嵌 \n 由 json.dumps 转义）
        _REAL_OUT.write(json.dumps({'id': req_id, 'ok': ok, 'data': data}, ensure_ascii=False) + '\n')
        _REAL_OUT.flush()


def _serialize_raw(result):
    """把蜘蛛返回值转成可 JSON 传输的字符串：dict/list → json；str 原样。"""
    if isinstance(result, str):
        return result
    return json.dumps(result, ensure_ascii=False)


def main():
    # ★ 蜘蛛 print() → stderr（结果/信封走 _REAL_OUT，见其注释）：行协议不被日志碎片打穿
    sys.stdout = sys.stderr
    # ★ 常驻模式：runner.py -serve <pyPath> <className>
    if len(sys.argv) >= 4 and sys.argv[1] == '-serve':
        _serve(sys.argv[2], sys.argv[3])
        return
    if len(sys.argv) < 3:
        raise SystemExit('usage: runner.py <pyPath> <className> <method> [ext] [args...]')
    py_path = sys.argv[1]
    class_name = sys.argv[2]
    method = sys.argv[3]
    ext = sys.argv[4] if len(sys.argv) > 4 else ''

    ns = _load_script(py_path)
    sp = _new_instance(ns, class_name)

    # init(ext) no-op 容错（部分脚本不实现 init）
    try:
        sp.init(ext)
    except (AttributeError, TypeError):
        pass

    # 方法分派：argv[5..] 即实参（与一次性协议对齐：ext 之后全是方法实参）
    rest = sys.argv[5:]
    result = _call_method(sp, method, rest)
    _serialize(result)


if __name__ == '__main__':
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        _fail(e)