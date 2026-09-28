package android.os;

/**
 * android.os.Process stub —— 进程/线程身份查询（隐藏 API 家族的常用入口）。
 *
 * ★ 2026-09-26 新增（壳类来源取证）：Fixture/加固壳在 SO 装载阶段会反射
 *   {@code Class.forName("android.os.Process")} 取 {@code myPid()/myTid()/myUid()}
 *   （给 native 侧做「同进程校验」/租约绑定）。缺失 → 反射 Method 为 null →
 *   在壳内 VM 里 {@code invoke(null)} 直接 NPE（message 为 null，日志只见
 *   `[FishSoLoader] prepare failed: NullPointerException: null`），随后整条加密链路降级。
 *   因此这里按 AOSP 语义给**确定值**（pid/tid = 宿主进程真实值，uid = 应用 uid）。
 *
 * 语义选择：桌面版是普通 Win32 进程，没有 Android 的 uid 体系 → uid 用 10000
 * （AOSP FIRST_APPLICATION_UID），is64Bit 跟随宿主 JVM。
 */
public class Process {

    // ---- 优先级常量（AOSP 值） ----
    public static final int THREAD_PRIORITY_AUDIO = -16;
    public static final int THREAD_PRIORITY_BACKGROUND = 10;
    public static final int THREAD_PRIORITY_DEFAULT = 0;
    public static final int THREAD_PRIORITY_DISPLAY = -4;
    public static final int THREAD_PRIORITY_FOREGROUND = -2;
    public static final int THREAD_PRIORITY_LESS_FAVORABLE = 1;
    public static final int THREAD_PRIORITY_LOWEST = 19;
    public static final int THREAD_PRIORITY_MORE_FAVORABLE = -1;
    public static final int THREAD_PRIORITY_URGENT_AUDIO = -19;
    public static final int THREAD_PRIORITY_URGENT_DISPLAY = -8;
    public static final int THREAD_PRIORITY_VIDEO = -10;

    // ---- uid / pid 相关 ----
    public static final int FIRST_APPLICATION_UID = 10000;
    public static final int LAST_APPLICATION_UID = 19999;
    public static final int SYSTEM_UID = 1000;
    public static final int PHONE_UID = 1001;
    public static final int BLUETOOTH_UID = 1002;
    public static final int SHELL_UID = 2000;
    public static final int LOG_UID = 1007;
    public static final int NFC_UID = 1027;
    public static final int MEDIA_UID = 1013;
    public static final int WIFI_UID = 1010;
    public static final int ROOT_UID = 0;
    public static final int MY_PID = 0;
    public static final int MY_TID = 0;
    public static final int MY_UID = 0;
    public static final int MY_USER_HANDLE = 0;

    // ---- 信号 ----
    public static final int SIGNAL_KILL = 9;
    public static final int SIGNAL_QUIT = 3;
    public static final int SIGNAL_USR1 = 10;

    private static final int PID = hostPid();
    private static final int UID = FIRST_APPLICATION_UID;

    public Process() {
    }

    public static int myPid() {
        return PID;
    }

    public static int myTid() {
        return PID;
    }

    public static int myUid() {
        return UID;
    }

    public static int myPpid() {
        return 1;
    }

    public static int getUidForPid(int pid) {
        return UID;
    }

    public static int getParentPid(int pid) {
        return 1;
    }

    public static final int getUidForName(String name) {
        return -1;
    }

    public static final int getThreadPriority(int tid) {
        return THREAD_PRIORITY_DEFAULT;
    }

    public static final void setThreadPriority(int priority) {
    }

    public static final void setThreadPriority(int tid, int priority) {
    }

    public static final void setThreadGroup(int tid, int group) {
    }

    public static final void setProcessGroup(int pid, int group) {
    }

    public static final void killProcess(int pid) {
    }

    public static final void killProcessQuiet(int pid) {
    }

    public static final void sendSignal(int pid, int signal) {
    }

    public static final void sendSignalQuiet(int pid, int signal) {
    }

    public static final boolean supportsProcesses() {
        return true;
    }

    public static final boolean is64Bit() {
        return "64".equals(System.getProperty("sun.arch.data.model", "64"));
    }

    public static boolean isIsolated() {
        return false;
    }

    public static final long getStartElapsedRealtime() {
        return android.os.SystemClock.elapsedRealtime();
    }

    public static final long getStartUptimeMillis() {
        return android.os.SystemClock.uptimeMillis();
    }

    public static final long getElapsedCpuTime() {
        return System.nanoTime() / 1000000L;
    }

    public static final int[] getPids(String path, int[] lastArray) {
        return new int[0];
    }

    public static final int[] getPidsForCommands(String[] cmds) {
        return new int[0];
    }

    /** 宿主是普通桌面进程，没有 /proc 可读 → 空数组（调用方按「查不到」处理，不 NPE）。 */
    public static final byte[] readProcFile(String file, int[] outLen, String[] outStr, int[] outInt,
                                            long[] outLong, float[] outFloat) {
        if (outLen != null && outLen.length > 0) outLen[0] = 0;
        return new byte[0];
    }

    public static final int parseProcLine(byte[] buffer, int startIndex, int endIndex, int[] format,
                                          int[] outInt, long[] outLong, float[] outFloat, String[] outStrings) {
        return 0;
    }

    public static final int setArgV0(String text) {
        return 0;
    }

    private static int hostPid() {
        try {
            // JDK9+: ProcessHandle.current().pid()
            Object h = Class.forName("java.lang.ProcessHandle").getMethod("current").invoke(null);
            Object pid = h.getClass().getMethod("pid").invoke(h);
            return ((Long) pid).intValue();
        } catch (Throwable t) {
            return 12345;
        }
    }
}