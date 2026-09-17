package android.content;

/** DialogInterface stub：蜘蛛只用它的 OnClickListener / OnDismissListener 回调类型。 */
public interface DialogInterface {
    void dismiss();
    void cancel();

    interface OnClickListener {
        void onClick(DialogInterface dialog, int which);
    }

    interface OnDismissListener {
        void onDismiss(DialogInterface dialog);
    }

    interface OnCancelListener {
        void onCancel(DialogInterface dialog);
    }
}
