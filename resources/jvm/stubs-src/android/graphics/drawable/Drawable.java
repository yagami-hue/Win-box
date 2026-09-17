package android.graphics.drawable;

import android.graphics.Canvas;

/** Drawable stub。 */
public class Drawable {
    public void setBounds(int left, int top, int right, int bottom) { }
    public void setAlpha(int alpha) { }
    public int getAlpha() { return 255; }
    public int getIntrinsicWidth() { return -1; }
    public int getIntrinsicHeight() { return -1; }
    public void draw(Canvas canvas) { }
}
