package android.graphics.drawable;

/** ColorDrawable stub（弹窗背景色，无 UI 宿主故仅保留签名）。 */
public class ColorDrawable extends Drawable {
    private int mColor = 0;

    public ColorDrawable() { }
    public ColorDrawable(int color) { this.mColor = color; }

    public void setColor(int color) { this.mColor = color; }
    public int getColor() { return mColor; }
}
