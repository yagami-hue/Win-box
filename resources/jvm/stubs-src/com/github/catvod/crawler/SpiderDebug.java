package com.github.catvod.crawler;

/**
 * SpiderDebug —— 蜘蛛调试日志（与基线行为一致）。
 * log(Throwable) 仅记一行 message，不打印完整堆栈（避免刷 stderr）。
 *
 * ★ 诊断开关（-Dtvbox.trace.log=1，默认关闭）：额外把「日志调用点」的 Java 调用栈打到 stderr。
 *   用途：壳类日志（如 `[FishSoLoader] prepare failed`）只在被混淆的类里，静态读不出归属；
 *   开栈即可定位到具体类/方法，属于离线取证手段，不影响正常行为。
 */
public class SpiderDebug {

    private static final boolean TRACE = "1".equals(System.getProperty("tvbox.trace.log"));

    private static void trace(String msg, Throwable th) {
        try {
            StackTraceElement[] st = (th == null ? new Throwable() : th).getStackTrace();
            StringBuilder sb = new StringBuilder(msg == null ? "(null)" : msg);
            int start = th == null ? 1 : 0;
            for (int i = start; i < Math.min(st.length, 18); i++) sb.append("\n    at ").append(st[i]);
            System.err.println("[trace] " + sb);
            if (th != null) th.printStackTrace(System.err);
        } catch (Throwable ignore) {
        }
    }

    public static void log(Throwable th) {
        try {
            if (TRACE) trace("[trace-msg] " + th.getClass().getName() + ": " + th.getMessage() + " | " + th.getMessage(), th);
            android.util.Log.d("SpiderLog", th.getMessage(), th);
        } catch (Throwable th1) {
        }
    }

    public static void log(String msg) {
        try {
            if (TRACE) trace(msg, null);
            android.util.Log.d("SpiderLog", msg);
        } catch (Throwable th1) {
        }
    }

    public static String ec(int i) {
        return "";
    }
}
