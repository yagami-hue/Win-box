package android.app;

import android.content.Context;
import android.content.DialogInterface;
import android.view.View;
import android.widget.EditText;

/**
 * Dialog stub：蜘蛛用 AlertDialog.Builder 搭「输入框 + 确定/取消」交互 UI。
 * 桌面移植版无 UI 宿主，这里保留完整可编译签名，调用一律 no-op（返回自身 / null）。
 * 关键：必须存在，否则 spiders 在 ClassLoader 解析期抛
 * ClassNotFoundException: android.app.AlertDialog（表现为「蜘蛛返回空结果」）。
 */
public class Dialog implements DialogInterface {
    protected Context mContext;

    public Dialog(Context context) {
        this.mContext = context;
    }

    public void setTitle(CharSequence title) { }
    public void setTitle(int titleId) { }
    public void setContentView(View view) { }
    public void show() { }
    public void hide() { }
    @Override public void dismiss() { }
    @Override public void cancel() { }
    public boolean isShowing() { return false; }
    public void setOnDismissListener(OnDismissListener listener) { }
    public void setOnCancelListener(OnCancelListener listener) { }
    public void setCancelable(boolean flag) { }
    public Context getContext() { return mContext; }
}
