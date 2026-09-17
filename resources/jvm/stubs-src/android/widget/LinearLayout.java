package android.widget;

import android.content.Context;
import android.util.AttributeSet;
import android.view.ViewGroup;

/**
 * LinearLayout stub —— 消除 fty 后台线程加载 android.widget.LinearLayout 的
 * NoClassDefFoundError 噪声。继承既有 ViewGroup stub；方法默认返回。
 */
public class LinearLayout extends ViewGroup {

    public static final int HORIZONTAL = 0;
    public static final int VERTICAL = 1;

    public LinearLayout(Context context) { super(context); }
    public LinearLayout(Context context, AttributeSet attrs) { super(context, attrs); }

    public void setOrientation(int orientation) { }
    public int getOrientation() { return VERTICAL; }
    public void setGravity(int gravity) { }
    public int getGravity() { return 0; }
    public void setBaselineAligned(boolean baselineAligned) { }
    public boolean isBaselineAligned() { return true; }
    public void setWeightSum(float weightSum) { }
    public float getWeightSum() { return 0f; }
    public void setDividerSoundsEnabled(boolean enabled) { }

    /** LayoutParams stub：与 Android SDK 契约一致，含 weight/gravity 与布局尺寸常量。 */
    public static class LayoutParams extends android.view.ViewGroup.LayoutParams {
        public static final int WRAP_CONTENT = -2;
        public static final int MATCH_PARENT = -1;
        public float weight;
        public int gravity;

        public LayoutParams(int width, int height) { super(width, height); }
        public LayoutParams(android.content.Context c, android.util.AttributeSet attrs) { super(c, attrs); }
        public LayoutParams(android.view.ViewGroup.LayoutParams p) { super(p); }
        public LayoutParams(android.view.ViewGroup.MarginLayoutParams p) { super(p); }
        public void setMargins(int l, int t, int r, int b) { }
        public int getMarginStart() { return 0; }
        public int getMarginEnd() { return 0; }
    }
}