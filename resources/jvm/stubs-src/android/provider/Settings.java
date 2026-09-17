package android.provider;

import android.content.ContentResolver;

/**
 * Settings stub —— 系统设置表访问。
 *
 * ★ 2026-09-16 修复：瓜子（Appgz）init 阶段调用 Settings.Secure 做设备探测
 *   （ClassNotFoundException: android.provider.Settings$Secure）。
 *   桌面版无真实系统设置，返回占位值即可让蜘蛛继续流程。
 */
public class Settings {

    public static final String ACTION_SETTINGS = "android.settings.SETTINGS";
    public static final String ACTION_WIFI_SETTINGS = "android.settings.WIFI_SETTINGS";

    public static String getString(ContentResolver cr, String name) {
        return null;
    }

    /**
     * 系统安全设置 —— 常用：android_id / adb_enabled 等。
     */
    public static final class Secure {

        public static final String ANDROID_ID = "android_id";
        public static final String ADB_ENABLED = "adb_enabled";
        public static final String INSTALL_NON_MARKET_APPS = "install_non_market_apps";

        /** 返回占位设备标识，避免 null 下游 NPE */
        public static String getString(ContentResolver cr, String name) {
            if (ANDROID_ID.equals(name)) {
                return "tvbox-win-000000000000";
            }
            return null;
        }

        /** 兼容直接传 Context 的调用形态 */
        public static String getString(android.content.Context context, String name) {
            return getString(context == null ? null : context.getContentResolver(), name);
        }

        public static String getStringForUser(ContentResolver cr, String name, int userHandle) {
            return getString(cr, name);
        }
    }

    /** 系统全局设置 */
    public static final class Global {
        public static String getString(ContentResolver cr, String name) {
            return null;
        }
    }
}
