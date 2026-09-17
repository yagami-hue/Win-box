package android.widget;

import android.content.Context;
import android.util.AttributeSet;
import android.view.View;

/**
 * Button stub —— 按钮控件（无 UI 宿主，全部 no-op）。
 *
 * <p>真实调用面（扫描确认，merge/h1/j/h 和 merge/h1/j/k）：
 * 构造器 {@code (Context)}、{@code setText(CharSequence)}、{@code setOnClickListener}、
 * {@code setEnabled}、{@code setVisibility}。setXxx 由父类 View/TextView 提供。
 *
 * <p>★ 本类必须继承 TextView（不是直接继承 View）：内嵌 WebView 库把 Button
 * 当 TextView 用（{@code invokevirtual TextView.setText} 的接收者是 Button 实例），
 * 类型链断了会 VerifyError。
 */
public class Button extends TextView {

    public Button(Context context) {
        super(context);
    }

    public Button(Context context, AttributeSet attrs) {
        super(context);
    }

    public Button(Context context, AttributeSet attrs, int defStyleAttr) {
        super(context);
    }

    @Override
    public void setOnClickListener(View.OnClickListener l) {
    }

    public void setOnLongClickListener(View.OnLongClickListener l) {
    }

    public void setEnabled(boolean enabled) {
    }

    public boolean isEnabled() {
        return true;
    }
}
