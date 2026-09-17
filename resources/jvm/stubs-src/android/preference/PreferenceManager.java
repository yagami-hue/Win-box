package android.preference;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * PreferenceManager stub —— 安卓偏好设置管理入口。
 *
 * 蜘蛛（如 fty 的 merge.HE / ProxyOrigin.getan）常用
 * {@code PreferenceManager.getDefaultSharedPreferences(ctx).getString(...)}
 * 读写持久化配置。缺少本类会直接 {@code ClassNotFoundException}，
 * 导致 playerContent 等调用整体失败。
 *
 * 能力边界：桌面版无每包名独立偏好文件，统一返回进程内共用的默认
 * {@link SharedPreferences$Mem}（与 Context.getSharedPreferences 同源）。
 */
public class PreferenceManager {

    public static final String METADATA_KEY_PREFERENCES = "android.preference";

    public static SharedPreferences getDefaultSharedPreferences(Context context) {
        // 与 Context.getSharedPreferences("default") 对齐的进程内内存偏好
        return SharedPreferences.Mem.get("default");
    }
}