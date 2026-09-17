package android.widget;

import android.content.Context;
import android.text.Editable;
import android.view.View;
import android.view.ViewGroup;

/** TextView stub（蜘蛛用于弹窗/提示文案，无 UI 宿主故全部 no-op）。 */
public class TextView extends View {
    private CharSequence mText = "";

    public TextView(Context context) { super(); }

    public void setText(CharSequence text) { this.mText = text; }
    public void setText(int resId) { }
    public CharSequence getText() { return mText; }
    public Editable getEditableText() { return null; }
    public void setHint(CharSequence hint) { }
    public void setHint(int resId) { }
    public void setSingleLine(boolean singleLine) { }
    public void setMaxLines(int maxLines) { }
    public void setTextSize(float size) { }
    public void setTextColor(int color) { }
    public void setGravity(int gravity) { }
    public void setPadding(int l, int t, int r, int b) { }
    public void setLayoutParams(ViewGroup.LayoutParams params) { }
}
