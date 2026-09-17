package android.view;

/**
 * Window stub —— 窗口对象。
 *
 * 桌面 TVBox 无 UI 窗口，但 fty 系蜘蛛的弹幕初始化（ProxyOrigin.getan）会走
 * Activity.getWindow().getDecorView() 遍历视图树查找 TextView。为让这条链不 NPE，
 * 这里给 getDecorView() 一个空 View（非 null、非 ViewGroup 非 TextView）——
 * 递归查找会直接返回空结果，等价"桌面上没有弹幕 UI"。
 */
public class Window {

    public Window() {
    }

    public void setFlags(int flags, int mask) {
    }

    public void setFormat(int format) {
    }

    public void addFlags(int flags) {
    }

    /**
     * 根视图。返回非 null 的空 View：蜘蛛的 findView 遍历会因"既非 ViewGroup
     * 也非 TextView"而立即返回空列表，不会递归也不会 NPE。
     */
    public View getDecorView() {
        return new View();
    }
}