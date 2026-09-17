package android.view;

import android.content.Context;
import android.util.AttributeSet;

/**
 * ViewGroup stub —— 视图容器 + 布局参数。
 *
 * ★ 2026-09-10 第四轮修复：新增 `MarginLayoutParams`（此前缺失导致
 *   `ClassNotFoundException: android.view.ViewGroup$MarginLayoutParams`）。
 *   MarginLayoutParams 是 LinearLayout/RelativeLayout 等的 LayoutParams 基类，
 *   混淆工具库会 Class.forName 它。
 */
public class ViewGroup extends View implements ViewParent {

    public static final int FOCUS_BEFORE_DESCENDANTS = 0x20000;
    public static final int FOCUS_AFTER_DESCENDANTS = 0x40000;
    public static final int FOCUS_BLOCK_DESCENDANTS = 0x60000;
    public static final int PERSISTENT_NO_CACHE = 0;
    public static final int PERSISTENT_ANIMATION_CACHE = 1;
    public static final int PERSISTENT_SCROLLING_CACHE = 2;
    public static final int PERSISTENT_ALL_CACHES = 3;

    public ViewGroup(Context context) {
        super(context);
    }

    public ViewGroup(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    public ViewGroup(Context context, AttributeSet attrs, int defStyleAttr) {
        super(context, attrs, defStyleAttr);
    }

    public void addView(View child) {
    }

    public void addView(View child, int index) {
    }

    public void addView(View child, int width, int height) {
    }

    public void addView(View child, LayoutParams params) {
    }

    public void addView(View child, int index, LayoutParams params) {
    }

    public void removeView(View view) {
    }

    public void removeViewAt(int index) {
    }

    public void removeAllViews() {
    }

    public void removeAllViewsInLayout() {
    }

    public void removeViews(int start, int count) {
    }

    public View getChildAt(int index) {
        return null;
    }

    public int getChildCount() {
        return 0;
    }

    public int indexOfChild(View child) {
        return -1;
    }

    public void removeViewInLayout(View view) {
    }

    public void setClipChildren(boolean clipChildren) {
    }

    public void setClipToPadding(boolean clipToPadding) {
    }

    public void setDescendantFocusability(int focusability) {
    }

    public void setOnHierarchyChangeListener(OnHierarchyChangeListener listener) {
    }

    public void setLayoutTransition(android.animation.LayoutTransition transition) {
    }

    @Override
    public ViewParent getParent() {
        return null;
    }

    public boolean isLayoutRequested() {
        return false;
    }

    public void requestDisallowInterceptTouchEvent(boolean disallowIntercept) {
    }

    public void invalidateChild(View child, android.graphics.Rect dirty) {
    }

    public ViewParent invalidateChildInParent(int[] location, android.graphics.Rect dirty) {
        return null;
    }

    public boolean getChildVisibleRect(View child, android.graphics.Rect r, android.graphics.Point offset) {
        return false;
    }

    public void bringChildToFront(View child) {
    }

    public boolean showContextMenuForChild(View originalView) {
        return false;
    }

    public void createContextMenu(ContextMenu menu) {
    }

    public void focusableViewAvailable(View v) {
    }

    public boolean canResolveLayoutDirection() {
        return false;
    }

    public void requestChildFocus(View child, View focused) {
    }

    public void clearChildFocus(View child) {
    }

    public View focusSearch(View v, int direction) {
        return null;
    }

    public void childHasTransientStateChanged(View child, boolean hasTransientState) {
    }

    public void measureChild(View child, int parentWidthMeasureSpec, int parentHeightMeasureSpec) {
    }

    public void measureChildren(int widthMeasureSpec, int heightMeasureSpec) {
    }

    public void setPadding(int left, int top, int right, int bottom) {
        super.setPadding(left, top, right, bottom);
    }

    /** 层级变更监听 */
    public interface OnHierarchyChangeListener {
        void onChildViewAdded(View parent, View child);

        void onChildViewRemoved(View parent, View child);
    }

    /**
     * ★ 带边距的布局参数 —— 此前缺失，是本次 ClassNotFoundException 的直接原因。
     */
    public static class MarginLayoutParams extends LayoutParams {

        public int leftMargin;
        public int topMargin;
        public int rightMargin;
        public int bottomMargin;

        private int startMargin = UNDEFINED_MARGIN;
        private int endMargin = UNDEFINED_MARGIN;

        private static final int UNDEFINED_MARGIN = Integer.MIN_VALUE;

        public MarginLayoutParams(Context c, AttributeSet attrs) {
            super(c, attrs);
        }

        public MarginLayoutParams(int width, int height) {
            super(width, height);
        }

        public MarginLayoutParams(MarginLayoutParams source) {
            super(source);
            if (source != null) {
                this.leftMargin = source.leftMargin;
                this.topMargin = source.topMargin;
                this.rightMargin = source.rightMargin;
                this.bottomMargin = source.bottomMargin;
            }
        }

        public MarginLayoutParams(LayoutParams source) {
            super(source);
        }

        public void setMargins(int left, int top, int right, int bottom) {
            this.leftMargin = left;
            this.topMargin = top;
            this.rightMargin = right;
            this.bottomMargin = bottom;
        }

        public void setMarginStart(int start) {
            this.startMargin = start;
        }

        public int getMarginStart() {
            return startMargin;
        }

        public void setMarginEnd(int end) {
            this.endMargin = end;
        }

        public int getMarginEnd() {
            return endMargin;
        }

        public boolean isMarginRelative() {
            return startMargin != UNDEFINED_MARGIN || endMargin != UNDEFINED_MARGIN;
        }

        public void resolveLayoutDirection(int layoutDirection) {
        }

        @Override
        public String toString() {
            return "MarginLayoutParams{w=" + width + ", h=" + height
                    + ", l=" + leftMargin + ", t=" + topMargin
                    + ", r=" + rightMargin + ", b=" + bottomMargin + "}";
        }
    }
}
