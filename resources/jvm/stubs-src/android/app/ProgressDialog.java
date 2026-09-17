package android.app;

import android.content.Context;
import android.content.DialogInterface;
import android.view.View;

/**
 * ProgressDialog stub —— 进度对话框（Market 蜘蛛用它展示"加载中"）。
 *
 * <p>真实调用面（扫描确认，Market）：{@code show(Context,CharSequence,CharSequence)}、
 * {@code setMessage}、{@code setTitle}、{@code setCancelable}、{@code show()}、
 * {@code dismiss()}、{@code isShowing()}、{@code setProgress(int)}。
 *
 * <p>★ 桌面上没有 UI，但 {@code isShowing()} 必须**如实反映 show/dismiss 状态**：
 * 蜘蛛常写 {@code if (!dialog.isShowing()) return;} 这类守卫，恒返回 false
 * 会让它的正常路径被跳过（"蜘蛛返回空结果"的元凶之一）。
 */
public class ProgressDialog extends Dialog {

    public static final int STYLE_SPINNER = 0;
    public static final int STYLE_HORIZONTAL = 1;

    private boolean mShowing;
    private CharSequence mMessage = "";
    private CharSequence mTitle = "";
    private int mMax = 100;
    private int mProgress;
    private boolean mIndeterminate = true;

    public ProgressDialog(Context context) {
        super(context);
    }

    public ProgressDialog(Context context, int theme) {
        super(context);
    }

    public static ProgressDialog show(Context context, CharSequence title, CharSequence message) {
        ProgressDialog d = new ProgressDialog(context);
        d.mTitle = title;
        d.mMessage = message;
        d.show();
        return d;
    }

    public static ProgressDialog show(Context context, CharSequence title, CharSequence message,
                                      boolean indeterminate) {
        ProgressDialog d = show(context, title, message);
        d.mIndeterminate = indeterminate;
        return d;
    }

    public static ProgressDialog show(Context context, CharSequence title, CharSequence message,
                                      boolean indeterminate, boolean cancelable) {
        ProgressDialog d = show(context, title, message, indeterminate);
        d.setCancelable(cancelable);
        return d;
    }

    public static ProgressDialog show(Context context, CharSequence title, CharSequence message,
                                      boolean indeterminate, boolean cancelable,
                                      DialogInterface.OnCancelListener cancelListener) {
        ProgressDialog d = show(context, title, message, indeterminate, cancelable);
        d.setOnCancelListener(cancelListener);
        return d;
    }

    @Override
    public void show() {
        mShowing = true;
    }

    @Override
    public void dismiss() {
        mShowing = false;
    }

    @Override
    public void cancel() {
        mShowing = false;
    }

    @Override
    public boolean isShowing() {
        return mShowing;
    }

    @Override
    public void setTitle(CharSequence title) {
        this.mTitle = title;
    }

    @Override
    public void setTitle(int titleId) {
    }

    public void setMessage(CharSequence message) {
        this.mMessage = message;
    }

    public CharSequence getMessage() {
        return mMessage;
    }

    public void setProgressStyle(int style) {
    }

    public void setProgress(int value) {
        this.mProgress = value;
    }

    public int getProgress() {
        return mProgress;
    }

    public void setMax(int max) {
        this.mMax = max;
    }

    public int getMax() {
        return mMax;
    }

    public void incrementProgressBy(int diff) {
        this.mProgress += diff;
    }

    public void setIndeterminate(boolean indeterminate) {
        this.mIndeterminate = indeterminate;
    }

    public boolean isIndeterminate() {
        return mIndeterminate;
    }

    public void setProgressDrawable(android.graphics.drawable.Drawable d) {
    }

    public void setSecondaryProgress(int secondaryProgress) {
    }
}
