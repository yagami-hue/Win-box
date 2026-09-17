package android.view.animation;

/**
 * Interpolator stub —— 动画插值器（旧版位于 android.view.animation，安卓 3.0 起
 * 继承自 android.animation.TimeInterpolator）。
 *
 * <p>真实调用面（扫描确认，merge/m/a、merge/p/a、android.widget.Scroller 构造器）：
 * {@code getInterpolation(float)}。桌面端无动画，恒等返回输入值即可。
 *
 * <p>★ 继承关系要正确：蜘蛛可能把它当 {@code android.animation.TimeInterpolator}
 * 传参（隐式向上转型用 {@code checkcast}），少了父接口会 VerifyError。
 */
public interface Interpolator extends android.animation.TimeInterpolator {
}
