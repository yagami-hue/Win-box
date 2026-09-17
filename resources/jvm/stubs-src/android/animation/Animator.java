package android.animation;

/**
 * Animator stub —— 动画基类。
 *
 * 桌面版无动画系统：start/cancel 只翻转状态位，addListener 记录后不回调
 * （不自动回调 onAnimationEnd，避免调用方在非预期时机执行后续逻辑）。
 */
public abstract class Animator {

    public static final long DURATION_INDEFINITE = -1L;

    private long duration = 300L;
    private long startDelay = 0L;
    private TimeInterpolator interpolator = null;
    private boolean started = false;

    public void start() {
        started = true;
    }

    public void cancel() {
        started = false;
    }

    public void end() {
        started = false;
    }

    public boolean isStarted() {
        return started;
    }

    public boolean isRunning() {
        return false;
    }

    public long getDuration() {
        return duration;
    }

    public Animator setDuration(long duration) {
        this.duration = duration;
        return this;
    }

    public long getStartDelay() {
        return startDelay;
    }

    public void setStartDelay(long startDelay) {
        this.startDelay = startDelay;
    }

    public TimeInterpolator getInterpolator() {
        return interpolator;
    }

    public void setInterpolator(TimeInterpolator value) {
        this.interpolator = value;
    }

    public void addListener(AnimatorListener listener) {
    }

    public void removeListener(AnimatorListener listener) {
    }

    public void removeAllListeners() {
    }

    public interface AnimatorListener {
        void onAnimationStart(Animator animation, boolean isReverse);

        void onAnimationEnd(Animator animation, boolean isReverse);

        void onAnimationCancel(Animator animation);

        void onAnimationRepeat(Animator animation);
    }

    /** 兼容旧 API 的适配接口 */
    public static class AnimatorListenerAdapter implements AnimatorListener {
        @Override
        public void onAnimationStart(Animator animation, boolean isReverse) {
        }

        @Override
        public void onAnimationEnd(Animator animation, boolean isReverse) {
        }

        @Override
        public void onAnimationCancel(Animator animation) {
        }

        @Override
        public void onAnimationRepeat(Animator animation) {
        }
    }
}
