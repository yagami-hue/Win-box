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
}