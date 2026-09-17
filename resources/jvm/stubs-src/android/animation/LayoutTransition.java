package android.animation;

import android.view.View;
import android.view.ViewGroup;

/**
 * LayoutTransition stub —— 布局过渡动画。
 * 桌面版无动画：只作为类型存在，setDuration 等为幂等空实现。
 */
public class LayoutTransition {

    public static final int CHANGE_APPEARING = 0;
    public static final int CHANGE_DISAPPEARING = 1;
    public static final int APPEARING = 2;
    public static final int DISAPPEARING = 3;
    public static final int CHANGING = 4;

    public static final int FLAG_APPEARING = 0x1;
    public static final int FLAG_DISAPPEARING = 0x2;
    public static final int FLAG_CHANGE_APPEARING = 0x4;
    public static final int FLAG_CHANGE_DISAPPEARING = 0x8;
    public static final int FLAG_CHANGING = 0x10;

    public LayoutTransition() {
    }

    public void setDuration(long duration) {
    }

    public void enableTransitionType(int transitionType) {
    }

    public void disableTransitionType(int transitionType) {
    }

    public boolean isTransitionTypeEnabled(int transitionType) {
        return false;
    }

    public void setStartDelay(int transitionType, long delay) {
    }

    public long getStartDelay(int transitionType) {
        return 0L;
    }

    public void setDuration(int transitionType, long duration) {
    }

    public long getDuration(int transitionType) {
        return 0L;
    }

    public void setInterpolator(int transitionType, android.animation.TimeInterpolator interpolator) {
    }

    public void setAnimator(int transitionType, android.animation.Animator animator) {
    }

    public void addTransitionListener(TransitionListener listener) {
    }

    public void removeTransitionListener(TransitionListener listener) {
    }

    public void setAnimateParentHierarchy(boolean animateParentHierarchy) {
    }

    public interface TransitionListener {
        void startTransition(LayoutTransition transition, ViewGroup container, View view, int transitionType);

        void endTransition(LayoutTransition transition, ViewGroup container, View view, int transitionType);
    }
}
