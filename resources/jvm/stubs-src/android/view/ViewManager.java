package android.view;

/**
 * ViewManager stub —— 容器管理接口（ViewGroup 与 WindowManager 的共同父接口）。
 *
 * <p>真实调用面：{@code addView(View, ViewGroup.LayoutParams)} /
 * {@code updateViewLayout} / {@code removeView}。内嵌 WebView 库对
 * WindowManager 全屏 View 操作时会走这些方法。
 *
 * <p>★ 架构上的必要性：合并前的基线里没有本接口，但 WindowManager 必须
 * extends 它（安卓原版如此）。若省略，蜘蛛侧 {@code ViewManager vm = wm;}
 * 这样的向上转型会 VerifyError。
 */
public interface ViewManager {

    void addView(View view, ViewGroup.LayoutParams params);

    void updateViewLayout(View view, ViewGroup.LayoutParams params);

    void removeView(View view);
}
