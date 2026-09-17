package android.graphics.drawable;

/**
 * GradientDrawable stub —— 消除 fty 后台线程（merge/A → cn）加载该 class 时的
 * NoClassDefFoundError 噪声。方法与 Android SDK 签名对齐，全部 no-op 默认返回。
 */
public class GradientDrawable extends Drawable {

    public enum Orientation {
        TOP_BOTTOM, TR_BL, RIGHT_LEFT, BR_TL, BOTTOM_TOP, BL_TR, LEFT_RIGHT, TL_BR
    }

    public GradientDrawable() { }
    public GradientDrawable(Orientation orientation, int[] colors) { }

    public int getShape() { return 0; }
    public void setShape(int shape) { }
    public void setGradientType(int gradient) { }
    public void setColor(int color) { }
    public void setColors(int[] colors) { }
    public void setStroke(int width, int color) { }
    public void setStroke(int width, int color, float dashWidth, float dashGap) { }
    public void setSize(int width, int height) { }
    public void setCornerRadius(float radius) { }
    public void setCornerRadii(float[] radii) { }
    public void setOrientation(Orientation orientation) { }
    public void setUseLevel(boolean useLevel) { }
    public void mutate() { }
    public android.graphics.drawable.Drawable getCurrent() { return this; }
}