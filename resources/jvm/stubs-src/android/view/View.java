package android.view;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Rect;
import android.util.AttributeSet;

/**
 * View stub —— Android 视图基类。
 *
 * ★ 2026-09-10 第四轮修复：补齐常用常量与 set/get 方法。
 *   蜘蛛/Room 在非 UI 链路也会引用 View 的常量（如 VISIBLE/GONE）与
 *   getContext/getWidth 等方法，缺一个就抛 NoSuchFieldError/NoSuchMethodError。
 *
 * 桌面版无 UI 树：所有几何量返回 0，setter 只记录不生效。
 */
public class View {

    // 可见性
    public static final int VISIBLE = 0x00000000;
    public static final int INVISIBLE = 0x00000004;
    public static final int GONE = 0x00000008;

    // 测量
    public static final int MEASURED_SIZE_MASK = 0x00ffffff;
    public static final int MEASURED_STATE_MASK = 0xff000000;
    public static final int MEASURE_SPEC_UNSPECIFIED = 0;
    public static final int MEASURE_SPEC_EXACTLY = 0x40000000;
    public static final int MEASURE_SPEC_AT_MOST = 0x80000000;

    public static final int FOCUSABLE = 0x00000001;
    public static final int CLICKABLE = 0x00000004;
    public static final int ENABLED = 0x00000020;
    public static final int FOCUSED = 0x00000002;
    public static final int SELECTED = 0x00000008;

    public static final int SCROLLBAR_POSITION_DEFAULT = 0;
    public static final int TEXT_ALIGNMENT_INHERIT = 0;
    public static final int TEXT_ALIGNMENT_GRAVITY = 1;
    public static final int TEXT_ALIGNMENT_TEXT_START = 2;
    public static final int TEXT_ALIGNMENT_TEXT_END = 3;
    public static final int TEXT_ALIGNMENT_CENTER = 4;
    public static final int TEXT_ALIGNMENT_VIEW_START = 5;
    public static final int TEXT_ALIGNMENT_VIEW_END = 6;

    private Context context;
    private int visibility = VISIBLE;
    private int id = NO_ID;
    private Object tag;
    private OnClickListener clickListener;
    private OnLongClickListener longClickListener;
    private OnFocusChangeListener focusChangeListener;
    private OnTouchListener touchListener;
    private int width;
    private int height;
    private int paddingLeft, paddingTop, paddingRight, paddingBottom;
    private float alpha = 1f;
    private boolean enabled = true;
    private boolean clickable = false;
    private boolean focusable = false;
    private boolean selected = false;
    private ViewParent parent;
    private LayoutParams layoutParams;

    public static final int NO_ID = -1;

    /** 无参构造器 —— 真实 Android 中为 protected，供子类/序列化使用 */
    protected View() {
        this.context = null;
    }

    public View(Context context) {
        this.context = context;
    }

    public View(Context context, AttributeSet attrs) {
        this.context = context;
    }

    public View(Context context, AttributeSet attrs, int defStyleAttr) {
        this.context = context;
    }

    // ---------------- context / 标识 ----------------

    public Context getContext() {
        return context;
    }

    public int getId() {
        return id;
    }

    public void setId(int id) {
        this.id = id;
    }

    public Object getTag() {
        return tag;
    }

    public void setTag(Object tag) {
        this.tag = tag;
    }

    public Object getTag(int key) {
        return null;
    }

    public void setTag(int key, Object tag) {
    }

    // ---------------- 可见性 ----------------

    public int getVisibility() {
        return visibility;
    }

    public void setVisibility(int visibility) {
        this.visibility = visibility;
    }

    public boolean isShown() {
        return visibility == VISIBLE;
    }

    // ---------------- 几何 ----------------

    public int getWidth() {
        return width;
    }

    public int getHeight() {
        return height;
    }

    public int getMeasuredWidth() {
        return width;
    }

    public int getMeasuredHeight() {
        return height;
    }

    public void setMinimumWidth(int minWidth) {
    }

    public void setMinimumHeight(int minHeight) {
    }

    public void getLocationOnScreen(int[] outLocation) {
        if (outLocation != null && outLocation.length >= 2) {
            outLocation[0] = 0;
            outLocation[1] = 0;
        }
    }

    public void getLocationInWindow(int[] outLocation) {
        getLocationOnScreen(outLocation);
    }

    public void getHitRect(Rect outRect) {
        if (outRect != null) {
            outRect.set(0, 0, width, height);
        }
    }

    public void getDrawingRect(Rect outRect) {
        getHitRect(outRect);
    }

    // ---------------- padding ----------------

    public int getPaddingLeft() { return paddingLeft; }
    public int getPaddingTop() { return paddingTop; }
    public int getPaddingRight() { return paddingRight; }
    public int getPaddingBottom() { return paddingBottom; }

    public void setPadding(int left, int top, int right, int bottom) {
        this.paddingLeft = left;
        this.paddingTop = top;
        this.paddingRight = right;
        this.paddingBottom = bottom;
    }

    // ---------------- 属性 ----------------

    public float getAlpha() {
        return alpha;
    }

    public void setAlpha(float alpha) {
        this.alpha = alpha;
    }

    public boolean isEnabled() {
        return enabled;
    }

    public void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }

    public boolean isClickable() {
        return clickable;
    }

    public void setClickable(boolean clickable) {
        this.clickable = clickable;
    }

    public boolean isFocusable() {
        return focusable;
    }

    public void setFocusable(boolean focusable) {
        this.focusable = focusable;
    }

    public boolean isSelected() {
        return selected;
    }

    public void setSelected(boolean selected) {
        this.selected = selected;
    }

    public boolean isFocused() {
        return false;
    }

    public boolean requestFocus() {
        return false;
    }

    public void setBackgroundColor(int color) {
    }

    public void setBackground(android.graphics.drawable.Drawable background) {
    }

    public void setBackgroundDrawable(android.graphics.drawable.Drawable background) {
    }

    public android.graphics.drawable.Drawable getBackground() {
        return null;
    }

    public void setBackgroundResource(int resid) {
    }

    public LayoutParams getLayoutParams() {
        return layoutParams;
    }

    public void setLayoutParams(LayoutParams params) {
        this.layoutParams = params;
    }

    public ViewParent getParent() {
        return parent;
    }

    public void setOnClickListener(OnClickListener l) {
        this.clickListener = l;
    }

    public void setOnLongClickListener(OnLongClickListener l) {
        this.longClickListener = l;
    }

    public void setOnFocusChangeListener(OnFocusChangeListener l) {
        this.focusChangeListener = l;
    }

    public void setOnTouchListener(OnTouchListener l) {
        this.touchListener = l;
    }

    public boolean performClick() {
        if (clickListener != null) {
            clickListener.onClick(this);
            return true;
        }
        return false;
    }

    public boolean performLongClick() {
        if (longClickListener != null) {
            return longClickListener.onLongClick(this);
        }
        return false;
    }

    // ---------------- 绘制 / 布局（空实现） ----------------

    public void layout(int l, int t, int r, int b) {
    }

    public final void measure(int widthMeasureSpec, int heightMeasureSpec) {
    }

    public void draw(Canvas canvas) {
    }

    public void invalidate() {
    }

    public void postInvalidate() {
    }

    public boolean post(Runnable action) {
        action.run();
        return true;
    }

    public boolean postDelayed(Runnable action, long delayMillis) {
        action.run();
        return true;
    }

    public void setOnKeyListener(OnKeyListener l) {
    }

    public void bringToFront() {
    }

    public void requestLayout() {
    }

    public void setFocusableInTouchMode(boolean focusableInTouchMode) {
    }

    public void setDescendantFocusability(int focusability) {
    }

    public void setSoundEffectsEnabled(boolean soundEffectsEnabled) {
    }

    public void setContentDescription(CharSequence contentDescription) {
    }

    public CharSequence getContentDescription() {
        return null;
    }

    public void sendAccessibilityEvent(int eventType) {
    }

    // ---------------- 接口 ----------------

    public interface OnClickListener {
        void onClick(View v);
    }

    public interface OnLongClickListener {
        boolean onLongClick(View v);
    }

    public interface OnFocusChangeListener {
        void onFocusChange(View v, boolean hasFocus);
    }

    public interface OnTouchListener {
        boolean onTouch(View v, MotionEvent event);
    }

    public interface OnKeyListener {
        boolean onKey(View v, int keyCode, KeyEvent event);
    }

    public interface OnLayoutChangeListener {
        void onLayoutChange(View v, int left, int top, int right, int bottom,
                            int oldLeft, int oldTop, int oldRight, int oldBottom);
    }

    /** 布局参数基类 */
    public static class LayoutParams {

        public static final int MATCH_PARENT = -1;
        public static final int FILL_PARENT = -1;
        public static final int WRAP_CONTENT = -2;

        public int width;
        public int height;

        public LayoutParams(int width, int height) {
            this.width = width;
            this.height = height;
        }

        public LayoutParams(Context c, AttributeSet attrs) {
            this.width = WRAP_CONTENT;
            this.height = WRAP_CONTENT;
        }

        public LayoutParams(LayoutParams source) {
            if (source != null) {
                this.width = source.width;
                this.height = source.height;
            }
        }

        public void setBaseAttributes(Object a, int widthAttr, int heightAttr) {
        }
    }
}
