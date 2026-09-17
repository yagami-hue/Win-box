package android.webkit;

import android.app.AlertDialog;
import android.content.DialogInterface;
import android.graphics.Bitmap;
import android.os.Message;
import android.view.KeyEvent;
import android.view.View;

/**
 * WebChromeClient stub —— WebView 的 chrome（标题/进度/JS 弹窗）回调。
 *
 * <p>真实调用面（扫描确认，merge/h1/j/f extends WebChromeClient）：
 * {@code onHideCustomView()}、{@code onJsAlert(WebView,String,String,JsResult)}、
 * {@code onShowCustomView(View,CustomViewCallback)}。
 *
 * <p>★ 这些方法**必须是 non-final 的 public 实例方法**：子类要 override，
 * 签名差一点（比如少了 @Override 对应的父方法）就会触发
 * "method does not override or implement a method from a supertype" 的
 * VerifyError —— 这正是 dex2jar 产物的典型雷区。
 */
public class WebChromeClient {

    /** 全屏自定义 View 回调。 */
    public interface CustomViewCallback {
        void onCustomViewHidden();
    }

    public WebChromeClient() {
    }

    public void onProgressChanged(WebView view, int newProgress) {
    }

    public void onReceivedTitle(WebView view, String title) {
    }

    public void onReceivedIcon(WebView view, Bitmap icon) {
    }

    public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
        return false;
    }

    public void onCloseWindow(WebView window) {
    }

    public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
        // 桌面端无 UI：直接当作用户确认，避免蜘蛛的 JS 回调链断掉。
        if (result != null) result.confirm();
        return true;
    }

    public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
        if (result != null) result.confirm();
        return true;
    }

    public boolean onJsPrompt(WebView view, String url, String message, String defaultValue, JsPromptResult result) {
        if (result != null) result.confirm(defaultValue);
        return true;
    }

    public boolean onJsBeforeUnload(WebView view, String url, String message, JsResult result) {
        if (result != null) result.confirm();
        return true;
    }

    public void onShowCustomView(View view, CustomViewCallback callback) {
    }

    @Deprecated
    public void onShowCustomView(View view, int requestedOrientation, CustomViewCallback callback) {
    }

    public void onHideCustomView() {
    }

    public boolean onJsTimeout() {
        return true;
    }

    public boolean onConsoleMessage(ConsoleMessage consoleMessage) {
        return false;
    }

    public Bitmap getDefaultVideoPoster() {
        return null;
    }

    public View getVideoLoadingProgressView() {
        return null;
    }

    public void onRequestFocus(WebView view) {
    }

    public boolean onShowFileChooser(WebView webView, ValueCallback<String[]> filePathCallback,
                                     FileChooserParams fileChooserParams) {
        return false;
    }

    /** AlertDialog 仅用于保持 AlertDialog 依赖可达（部分蜘蛛子类会用到）。 */
    @SuppressWarnings("unused")
    protected AlertDialog unusedDialogRef(DialogInterface.OnClickListener l) {
        return null;
    }

    @SuppressWarnings("unused")
    protected boolean unusedKeyEvent(KeyEvent e) {
        return false;
    }
}
