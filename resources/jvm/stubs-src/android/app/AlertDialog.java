package android.app;

import android.content.Context;
import android.content.DialogInterface;
import android.view.View;

/**
 * AlertDialog stub（含 Builder）。见 Dialog.java 说明：仅需「存在 + 可编译 + no-op」。
 * Builder 的 setXxx 一律返回 this 以支持链式调用。
 */
public class AlertDialog extends Dialog {

    public AlertDialog(Context context) {
        super(context);
    }

    public static class Builder {
        private final Context mContext;

        public Builder(Context context) {
            this.mContext = context;
        }

        public Builder setTitle(CharSequence title) { return this; }
        public Builder setTitle(int titleId) { return this; }
        public Builder setMessage(CharSequence message) { return this; }
        public Builder setMessage(int messageId) { return this; }
        public Builder setView(View view) { return this; }
        public Builder setIcon(int iconId) { return this; }
        public Builder setCancelable(boolean cancelable) { return this; }
        public Builder setPositiveButton(CharSequence text, DialogInterface.OnClickListener listener) { return this; }
        public Builder setPositiveButton(int textId, DialogInterface.OnClickListener listener) { return this; }
        public Builder setNegativeButton(CharSequence text, DialogInterface.OnClickListener listener) { return this; }
        public Builder setNegativeButton(int textId, DialogInterface.OnClickListener listener) { return this; }
        public Builder setNeutralButton(CharSequence text, DialogInterface.OnClickListener listener) { return this; }
        public Builder setNeutralButton(int textId, DialogInterface.OnClickListener listener) { return this; }
        public Builder setOnDismissListener(DialogInterface.OnDismissListener listener) { return this; }
        public Builder setOnCancelListener(DialogInterface.OnCancelListener listener) { return this; }

        public AlertDialog create() { return new AlertDialog(mContext); }
        public AlertDialog show() { return create(); }
    }
}
