package dalvik.system;

/**
 * dalvik.system.VMRuntime stub —— Android 隐藏 API（Art 运行时查询）。
 *
 * ★ 2026-09-26 新增（壳类来源取证，勿删）：加固壳装 SO 前会
 *   {@code Class.forName("dalvik.system.VMRuntime")} 取 {@code getRuntime()} 再调
 *   {@code vmInstructionSet()/is64Bit()}，据此在 assets 里**挑 v7/v8 两个 .so**。
 *   宿主没有这个类 → 反射链拿不到 Method → 壳内 VM {@code invoke(null)} → NPE（message 为 null），
 *   现象即 `[FishSoLoader] prepare failed: NullPointerException: null` + `prepare returned empty`。
 *
 * 语义选择：宿主用 unidbg 执行的是 **AArch64** .so（见 resources/jvm/native-bridge 的 ELF 判位），
 * 因此指令集固定报 {@code arm64}、is64Bit 报 true —— 与桥实际加载的 .so 保持一致。
 */
public final class VMRuntime {

    private static final VMRuntime INSTANCE = new VMRuntime();

    private int targetSdkVersion = 23;
    private long minimumHeapSize = 16 * 1024 * 1024L;
    private long maximumHeapSize = 256 * 1024 * 1024L;
    private long growthLimit = 192 * 1024 * 1024L;
    private boolean javaDebuggable = false;

    private VMRuntime() {
    }

    public static VMRuntime getRuntime() {
        return INSTANCE;
    }

    /** 当前进程指令集：arm64 / arm / x86_64 / x86 / none。宿主桥跑 AArch64 → arm64。 */
    public String vmInstructionSet() {
        return "arm64";
    }

    /** 静态版（API 23+）：返回「设备首选指令集」，同样按 arm64。 */
    public static String getCurrentInstructionSet() {
        return "arm64";
    }

    public String vmLibrary() {
        return "libart.so";
    }

    public String vmVersion() {
        return "2.1.0";
    }

    public boolean is64Bit() {
        return true;
    }

    public boolean isJavaDebuggable() {
        return javaDebuggable;
    }

    public void setJavaDebuggable(boolean value) {
        this.javaDebuggable = value;
    }

    public int getTargetSdkVersion() {
        return targetSdkVersion;
    }

    public boolean setTargetSdkVersion(int newTargetSdkVersion) {
        boolean changed = newTargetSdkVersion != targetSdkVersion;
        targetSdkVersion = newTargetSdkVersion;
        return changed;
    }

    public long getMinimumHeapSize() {
        return minimumHeapSize;
    }

    public long setMinimumHeapSize(long size) {
        long old = minimumHeapSize;
        minimumHeapSize = size;
        return old;
    }

    public long getMaximumHeapSize() {
        return maximumHeapSize;
    }

    public long setMaximumHeapSize(long size) {
        long old = maximumHeapSize;
        maximumHeapSize = size;
        return old;
    }

    public void gc() {
        System.gc();
    }

    public void clampGrowthLimit() {
    }

    public void clearGrowthLimit() {
    }

    public long getHeapSizeLimit() {
        return maximumHeapSize;
    }

    public boolean isCheckJniEnabled() {
        return false;
    }

    public void setCheckJniEnabled(boolean enabled) {
    }

    public String bootClassPath() {
        return System.getProperty("sun.boot.class.path", "");
    }

    public String classPath() {
        return System.getProperty("java.class.path", "");
    }

    public void setHiddenApiExemptions(String[] exemptions) {
    }

    public void setHiddenApiAccessLogSamplingRate(int rate) {
    }

    public void registerNativeFreeze(String name) {
    }

    public void unregisterNativeFreeze(String name) {
    }

    public void notifyStartupCompleted() {
    }

    public String toString() {
        return "VMRuntime[arm64, targetSdk=" + targetSdkVersion + "]";
    }
}