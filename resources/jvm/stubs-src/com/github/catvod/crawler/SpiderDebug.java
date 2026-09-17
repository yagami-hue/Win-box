package com.github.catvod.crawler;

/**
 * SpiderDebug —— 蜘蛛调试日志（与基线行为一致）。
 * log(Throwable) 仅记一行 message，不打印完整堆栈（避免刷 stderr）。
 */
public class SpiderDebug {
    public static void log(Throwable th) {
        try {
            android.util.Log.d("SpiderLog", th.getMessage(), th);
        } catch (Throwable th1) {
        }
    }

    public static void log(String msg) {
        try {
            android.util.Log.d("SpiderLog", msg);
        } catch (Throwable th1) {
        }
    }

    public static String ec(int i) {
        return "";
    }
}
