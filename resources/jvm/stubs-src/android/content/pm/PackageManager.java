package android.content.pm;

import android.content.ComponentName;

/**
 * PackageManager stub —— 包信息查询入口。
 *
 * 桌面移植版无真实包管理：所有查询返回空信息对象（非 null），
 * 权限检查一律 GRANTED（桌面版无沙箱权限模型）。
 *
 * ★ 2026-09-10 第四轮修复：补 PERMISSION_GRANTED/DENIED 常量与更多 flag，
 *   避免混淆工具库/蜘蛛在权限检查处抛 NoSuchFieldError。
 */
public class PackageManager {

    public static final int GET_ACTIVITIES = 0x00000001;
    public static final int GET_META_DATA = 0x00000080;
    public static final int GET_SIGNATURES = 0x00000040;
    public static final int GET_CONFIGURATIONS = 0x00004000;
    public static final int GET_RECEIVERS = 0x00000002;
    public static final int GET_SERVICES = 0x00000004;
    public static final int GET_PROVIDERS = 0x00000008;
    public static final int GET_DISABLED_COMPONENTS = 0x00000200;
    public static final int GET_DISABLED_UNTIL_USED_COMPONENTS = 0x00008000;
    public static final int GET_UNINSTALLED_PACKAGES = 0x00002000;

    public static final int PERMISSION_GRANTED = 0;
    public static final int PERMISSION_DENIED = -1;

    public static final String FEATURE_TELEVISION = "android.hardware.type.television";
    public static final String FEATURE_LEANBACK = "android.software.leanback";
    public static final String FEATURE_TOUCHSCREEN = "android.hardware.touchscreen";

    public static class NameNotFoundException extends Exception {
        public NameNotFoundException() { super(); }
        public NameNotFoundException(String name) { super(name); }
    }

    public PackageInfo getPackageInfo(String packageName, int flags) throws NameNotFoundException {
        return new PackageInfo();
    }

    public ApplicationInfo getApplicationInfo(String packageName, int flags) throws NameNotFoundException {
        ApplicationInfo info = new ApplicationInfo();
        info.packageName = packageName;
        return info;
    }

    public String getInstallerPackageName(String packageName) { return null; }

    public CharSequence getApplicationLabel(ApplicationInfo info) { return ""; }

    public ComponentName getLaunchIntentForPackage(String packageName) { return null; }

    public int checkPermission(String permName, String pkgName) { return PERMISSION_GRANTED; }

    public boolean hasSystemFeature(String name) { return false; }

    public String[] getPackagesForUid(int uid) { return new String[0]; }
}
