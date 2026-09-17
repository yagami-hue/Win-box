package android.widget;

import android.content.Context;
import android.text.Editable;

/** EditText stub（蜘蛛用它做「输入 Cookie/Token」等交互；桌面版无 UI，getText 返回空）。 */
public class EditText extends TextView {
    private CharSequence mText = "";

    public EditText(Context context) { super(context); }

    @Override public void setText(CharSequence text) { this.mText = text; }
    @Override public Editable getText() { return null; }
    public Editable getEditableTextNonNull() { return null; }
    public void setHint(CharSequence hint) { }
    public void setInputType(int type) { }
    public void setSelection(int index) { }
    public int getSelectionStart() { return 0; }
    public int getSelectionEnd() { return 0; }
}
