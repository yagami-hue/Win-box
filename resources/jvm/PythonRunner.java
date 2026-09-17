import java.io.File;

import org.python.core.PyBoolean;
import org.python.core.PyObject;
import org.python.core.PyString;
import org.python.util.PythonInterpreter;

/**
 * 桌面版 Python 运行器 —— 用 Jython（纯 Java，Python 2.7）在 JVM 内执行 .py 蜘蛛。
 *
 * 用法: PythonRunner <pyPath> <className> <method> [ext] [args...]
 *   与 SpiderRunner 对齐：argv[3]=ext（喂给 init），argv[4..]=方法实参。
 *   结果 JSON 打到 stdout；错误/日志走 stderr（复用 [SpiderRunner.ERROR] 标签，
 *   让 JarSpiderBridge 的 lastReason 提取零改动即生效）。
 *
 * ★ 硬约束：Jython 仅支持 Python 2.7。Python3-only 脚本（f-string / requests /
 *   type hints 等）必然失败 —— 上层已就这一点给出诚实文案（translateSpiderLog）。
 *   本运行器只负责"尽力执行 + 精确报错"，不承诺 1:1 语义。
 */
public class PythonRunner {

  public static void main(String[] args) {
    int code = 0;
    try {
      if (args.length < 3) {
        throw new IllegalArgumentException("usage: PythonRunner <pyPath> <className> <method> [ext] [args...]");
      }
      String pyPath = args[0];
      String className = args[1];
      String method = args[2];
      String ext = args.length > 3 && args[3] != null ? args[3] : "";
      String r0 = args.length > 4 ? args[4] : "";
      String r1 = args.length > 5 ? args[5] : "";
      String r2 = args.length > 6 ? args[6] : "";

      // 与 SpiderRunner 一致：尽力注册 BouncyCastle（Python 侧若走 JCE 也受益；失败无害）
      try {
        java.security.Security.addProvider(new org.bouncycastle.jce.provider.BouncyCastleProvider());
      } catch (Throwable ig) {
        System.err.println("[PythonRunner] BouncyCastle provider unavailable: " + ig);
      }

      PythonInterpreter pi = new PythonInterpreter();
      // 把脚本所在目录加入 sys.path，让脚本能 import 同目录的兄弟 .py
      File pf = new File(pyPath);
      String pyDir = (pf.getParent() == null ? "." : pf.getParent()).replace('\\', '/');
      pi.exec("import sys; sys.path.insert(0, r'" + safe(pyDir) + "')");
      pi.execfile(pyPath);

      PyObject cls = pi.get(className);
      if (cls == null) throw new IllegalStateException("Python 类不存在: " + className);
      PyObject sp = cls.__call__(); // 实例（无参构造）

      // init(ext)：no-op 容错（部分脚本不实现 init）
      try {
        sp.invoke("init", new PyString(ext));
      } catch (Throwable ig) { /* 无 init 定义，正常 */ }

      PyObject result;
      if ("homeContent".equals(method)) {
        result = invoke(sp, "homeContent", new PyBoolean(true));
      } else if ("homeVideoContent".equals(method)) {
        result = invoke(sp, "homeVideoContent");
      } else if ("categoryContent".equals(method)) {
        result = invoke(sp, "categoryContent",
            new PyString(r0), new PyString(r1.isEmpty() ? "1" : r1), new PyBoolean(true), new PyString(r2));
      } else if ("detailContent".equals(method)) {
        result = invoke(sp, "detailContent", parseJsonValue(pi, r0, "[]"));
      } else if ("searchContent".equals(method)) {
        PyString key = new PyString(r0);
        PyBoolean quick = new PyBoolean(false);
        if (!r2.isEmpty()) {
          // searchContent(key, quick, pg) 优先，脚本无 3 参签名则回退 2 参
          try {
            result = invoke(sp, "searchContent", key, quick, new PyString(r2));
          } catch (RuntimeException fallback) {
            result = invoke(sp, "searchContent", key, quick);
          }
        } else {
          result = invoke(sp, "searchContent", key, quick);
        }
      } else if ("playerContent".equals(method)) {
        result = invoke(sp, "playerContent",
            new PyString(r0), new PyString(r1), parseJsonValue(pi, r2, "[]"));
      } else if ("liveContent".equals(method)) {
        result = invoke(sp, "liveContent", new PyString(r0));
      } else if ("proxy".equals(method)) {
        result = invoke(sp, "proxy", new PyString(r0));
      } else {
        throw new IllegalArgumentException("unknown method: " + method);
      }
      // ★ 结果序列化成**严格 JSON**：Python dict 的 str() 是单引号 repr，非合法 JSON。
      //   用 jython 的 json.dumps 编码；若蜘蛛已自行返回 JSON 字符串则原样透传。
      pi.set("__py_out__", result);
      Object encoded = pi.eval(
          "(__py_out__ if isinstance(__py_out__, basestring) "
              + "else __import__('json').dumps(__py_out__, ensure_ascii=False))");
      System.out.println(encoded == null ? "" : encoded.toString());
    } catch (Throwable t) {
      Throwable cause = t;
      while (cause.getCause() != null) cause = cause.getCause();
      System.err.println("[SpiderRunner.ERROR] " + cause.getClass().getName() + ": " + cause.getMessage());
      for (StackTraceElement st : cause.getStackTrace()) System.err.println("    at " + st);
      code = 1;
    }
    System.exit(code);
  }

  /** 用 Jython 内置 json 把入参字符串解析成 Python 值（ids/vip 等数组参数）。 */
  private static PyObject parseJsonValue(PythonInterpreter pi, String s, String fallback) {
    if (s == null || s.trim().isEmpty()) return pi.eval(fallback);
    try {
      return pi.eval("__import__('json').loads(r'''" + safe(s) + "''')");
    } catch (Throwable ig) {
      return pi.eval(fallback);
    }
  }

  /** 显式组装 PyObject[] 调用继承方法，避免 Jython invoke 的多重重载在 javac 下解析歧义。 */
  private static PyObject invoke(PyObject sp, String name, Object... objs) {
    PyObject[] args = new PyObject[objs.length];
    for (int i = 0; i < objs.length; i++) args[i] = (PyObject) objs[i];
    return sp.invoke(name, args);
  }

  /** 把单引号转义，避免注入到 Python 字面量里。 */
  private static String safe(String s) {
    return s == null ? "" : s.replace("\\", "\\\\").replace("'", "\\'");
  }
}