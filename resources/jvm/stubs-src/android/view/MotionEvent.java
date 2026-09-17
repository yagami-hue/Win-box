package android.view;

/**
 * MotionEvent stub —— 触摸事件。
 * 桌面版无触摸屏：只作为类型存在，坐标恒 0。
 */
public class MotionEvent {

    public static final int ACTION_DOWN = 0;
    public static final int ACTION_UP = 1;
    public static final int ACTION_MOVE = 2;
    public static final int ACTION_CANCEL = 3;
    public static final int ACTION_OUTSIDE = 4;
    public static final int ACTION_POINTER_DOWN = 5;
    public static final int ACTION_POINTER_UP = 6;
    public static final int ACTION_HOVER_MOVE = 7;
    public static final int ACTION_SCROLL = 8;

    private final int action;
    private final float x;
    private final float y;

    private MotionEvent(int action, float x, float y) {
        this.action = action;
        this.x = x;
        this.y = y;
    }

    public static MotionEvent obtain(long downTime, long eventTime, int action,
                                     float x, float y, int metaState) {
        return new MotionEvent(action, x, y);
    }

    public static MotionEvent obtain(MotionEvent other) {
        return other == null ? new MotionEvent(ACTION_DOWN, 0, 0) : other;
    }

    public void recycle() {
    }

    public int getAction() {
        return action;
    }

    public int getActionMasked() {
        return action;
    }

    public float getX() {
        return x;
    }

    public float getY() {
        return y;
    }

    public float getRawX() {
        return x;
    }

    public float getRawY() {
        return y;
    }

    public int getPointerCount() {
        return 1;
    }

    public int getPointerId(int pointerIndex) {
        return 0;
    }

    public float getPressure() {
        return 1f;
    }

    public long getEventTime() {
        return 0L;
    }

    public long getDownTime() {
        return 0L;
    }

    public int getMetaState() {
        return 0;
    }
}
