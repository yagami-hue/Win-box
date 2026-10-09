package android.os;

import java.io.File;

/**
 * Environment stub —— 外部存储目录 / 存储状态。
 *
 * ★ 历史口径（勿改）：getExternalStorageDirectory() = `<java.io.tmpdir>/tvbox-ext`。
 *   Pizazz / 太太太硬了 系 jar 用它拼 `<外存>/TVBox/<盘>.txt`（`merge.m.k.b()`）读网盘 cookie，
 *   落点由 src/main/spider/driveCookieFiles.ts 同步维护 —— 改这里会连带改 cookie 文件落点。
 *
 * ★ 2026-10-09 补 isExternalStorageManager()（API 30+，MANAGE_EXTERNAL_STORAGE「所有文件访问权限」）：
 *   用户日志实证 `com.github.catvod.spider.Config.homeContent` 抛
 *   `NoSuchMethodError: 'boolean android.os.Environment.isExternalStorageManager()'`
 *   → 该「配置中心」源主页/搜索整体失败（上屏「桌面版缺失方法」）。
 *   桌面移植版无 Android 沙箱权限模型（蜘蛛总能读写自己的数据目录），
 *   与 Context.checkSelfPermission 的「一律 GRANTED」同口径 → 恒返回 true（走「已授权」分支）。
 */
public class Environment {

    public Environment() {
    }

    public static File getExternalStorageDirectory() {
        return new File(System.getProperty("java.io.tmpdir"), "tvbox-ext");
    }

    public static String getExternalStorageState() {
        return "mounted";
    }

    public static File getExternalStoragePublicDirectory(String type) {
        return getExternalStorageDirectory();
    }

    /** API 30+：是否持有「所有文件访问权限」——桌面无沙箱限制，恒 true（见类注释） */
    public static boolean isExternalStorageManager() {
        return true;
    }
}