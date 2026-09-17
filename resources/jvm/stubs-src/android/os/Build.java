package android.os;

/**
 * Build stub：蜘蛛读 Build.VERSION.SDK_INT / Build.MODEL 做分支。
 * 取一个较高的 SDK_INT（34 = Android 14）以走「新系统」分支，与安卓 TVBox 在
 * 现代设备上的行为一致；MODEL 填一个无害值。
 */
public class Build {
    public static final String MODEL = "TVBox";
    public static final String BRAND = "Android";
    public static final String MANUFACTURER = "Android";
    public static final String DEVICE = "generic";
    public static final String PRODUCT = "generic";
    public static final String ID = "TVBOX";
    public static final String DISPLAY = "TVBox Win";
    public static final String UNKNOWN = "unknown";

    /** 设备序列号（API 26 起弃用）——瓜子(Appgz)等蜘蛛 init 阶段读取做设备指纹 */
    public static final String SERIAL = "TVBOXWIN0000000000";

    // ---------------- CPU ABI ----------------
    //
    // ★ 这几个字段是「加固/壳」型蜘蛛的关键：它们按 CPU_ABI 决定加载哪个 native 库。
    //   典型（实测 com.github.catvod.spider.DexNative.<clinit>）：
    //
    //       String which = Build.CPU_ABI.contains("64") ? "v8" : "v7";
    //       → 从 assets 里提取 wexguard_v8.so / wexguard_v7.so → System.load(...)
    //
    //   缺失时抛 `NoSuchFieldError: CPU_ABI`，报错完全看不出与"加载 native 库"有关。
    //   这里取 32 位 ARM（安卓电视盒最常见），且**不含 "64"** —— 不去冒认一个
    //   本机（x64 Windows）根本不具备的 ABI 能力。
    //
    //   注：即便如此，安卓的 .so 是 ARM ELF + Bionic libc，与 Windows PE/DLL 属于
    //   不同 ABI，System.load 必然抛 UnsatisfiedLinkError。能否降级为纯 Java 路径
    //   取决于蜘蛛自己有没有 catch —— 本字段的作用是让这套分支逻辑**可被正确执行**，
    //   从而暴露出真实失败点，而不是卡在一个空指针上。
    public static final String CPU_ABI = "armeabi-v7a";
    public static final String CPU_ABI2 = "";
    public static final String HARDWARE = "generic";
    public static final String BOARD = "generic";
    public static final String FINGERPRINT = "Android/tvbox/generic:14/REL/1:user/release-keys";
    public static final String TAGS = "release-keys";
    public static final String TYPE = "user";
    public static final String HOST = "localhost";

    public static final String[] SUPPORTED_ABIS = new String[]{"armeabi-v7a", "armeabi"};
    public static final String[] SUPPORTED_32_BIT_ABIS = new String[]{"armeabi-v7a", "armeabi"};
    public static final String[] SUPPORTED_64_BIT_ABIS = new String[0];

    public static class VERSION {
        public static final int SDK_INT = 34;
        public static final String RELEASE = "14";
        public static final String CODENAME = "REL";
        public static final String INCREMENTAL = "1";
    }

    public static class VERSION_CODES {
        public static final int LOLLIPOP = 21;
        public static final int M = 23;
        public static final int N = 24;
        public static final int O = 26;
        public static final int P = 28;
        public static final int Q = 29;
        public static final int R = 30;
        public static final int S = 31;
        public static final int TIRAMISU = 33;
        public static final int UPSIDE_DOWN_CAKE = 34;
    }
}
