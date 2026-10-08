package android.app;

import android.content.ComponentName;
import android.view.Window;

/**
 * Activity stub —— 前台活动。
 *
 * 桌面 TVBox 无真实 Activity，但 fty 系蜘蛛的弹幕初始化（ProxyOrigin.getan）会先
 * InitOrigin.getActivity() 拿 Activity，再 Activity.getWindow().getDecorView() 查找视图。
 * 若 getWindow() 返回 null（历史实现），则 getDecorView() 直接 NPE。
 * 这里返回一个非 null 空 Window，让视图遍历安全地走到"无结果"分支。
 */
public class Activity extends android.content.Context {

    private final Window window = new Window();

    public Activity() {
        super();
    }

    public void runOnUiThread(Runnable action) {
    }

    public void finish() {
    }

    public Window getWindow() {
        return window;
    }

    /**
     * InitOrigin.getActivity() 会调用 {@code activity.getComponentName().getClassName()}
     * 打日志。需返回非 null ComponentName（否则 .getClassName() NPE）。
     */
    public ComponentName getComponentName() {
        return new ComponentName("com.github.tvbox.osc", "com.github.tvbox.osc.Main");
    }

    /**
     * ★ 2026-09-30（用户报「其他接口的盘搜类型源点搜索结果进不了详情」）：
     * 盘搜/网盘族蜘蛛（实测 小米订阅 `csp_MiSou`）在 detailContent 的**类初始化**里调用
     * `Activity.requestPermissions(String[], int)`（写外部存储前向系统申请权限，API 23+）；
     * 桩里缺这个方法 → `NoSuchMethodError` → `ExceptionInInitializerError` → 详情整体失败
     * （现象：搜索结果能出来、点进去详情空/自动跳全源搜索）。
     * 桌面版无运行时权限模型（也不是 Activity）→ 空实现即可（等价于"已授权"）。
     */
    public void requestPermissions(String[] permissions, int requestCode) {
    }
}