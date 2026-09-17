package android.widget;

/**
 * Scroller stub —— 滚动位置计算器（内嵌 WebView 库用于平滑滚动）。
 *
 * <p>真实调用面（扫描确认，merge/m/a、merge/p/a）：
 * {@code startScroll(int,int,int,int)} / {@code computeScrollOffset()} /
 * {@code getCurrX()} / {@code getCurrY()} / {@code isFinished()} / {@code abortAnimation()}。
 *
 * <p>★ {@code computeScrollOffset()} 必须返回 {@code false}：返回 true 会让调用方
 * 进入"滚动尚未结束 → 继续算下一帧"的循环；桌面端没有垂直同步信号，返回 true
 * 会造成忙等。这是"看着没报错但卡住/空结果"的典型来源。
 */
public class Scroller {

    private int mStartX;
    private int mStartY;
    private int mCurrX;
    private int mCurrY;
    private int mFinalX;
    private int mFinalY;

    public Scroller(android.content.Context context) {
    }

    public Scroller(android.content.Context context, android.view.animation.Interpolator interpolator) {
    }

    public Scroller(android.content.Context context, android.view.animation.Interpolator interpolator, boolean flywheel) {
    }

    public final void startScroll(int startX, int startY, int dx, int dy) {
        startScroll(startX, startY, dx, dy, 250);
    }

    public void startScroll(int startX, int startY, int dx, int dy, int duration) {
        this.mStartX = startX;
        this.mStartY = startY;
        this.mFinalX = startX + dx;
        this.mFinalY = startY + dy;
        this.mCurrX = startX;
        this.mCurrY = startY;
    }

    /** 桌面端无动画帧：一次性跳到终点，并声明"已结束"。 */
    public boolean computeScrollOffset() {
        mCurrX = mFinalX;
        mCurrY = mFinalY;
        return false;
    }

    public boolean isFinished() {
        return true;
    }

    public void abortAnimation() {
    }

    public void forceFinished(boolean finished) {
    }

    public final int getCurrX() {
        return mCurrX;
    }

    public final int getCurrY() {
        return mCurrY;
    }

    public final int getStartX() {
        return mStartX;
    }

    public final int getStartY() {
        return mStartY;
    }

    public final int getFinalX() {
        return mFinalX;
    }

    public final int getFinalY() {
        return mFinalY;
    }

    public int getDuration() {
        return 250;
    }

    public void extendDuration(int extend) {
    }

    public void setFinalX(int newX) {
        this.mFinalX = newX;
    }

    public void setFinalY(int newY) {
        this.mFinalY = newY;
    }

    public boolean isScrollingInDirection(float xvel, float yvel) {
        return false;
    }

    public float getCurrVelocity() {
        return 0f;
    }
}
