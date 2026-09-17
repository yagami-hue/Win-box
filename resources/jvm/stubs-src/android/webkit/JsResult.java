package android.webkit;

/**
 * JsResult stub —— JS 对话框（alert/confirm）的回执。
 *
 * <p>真实调用面（扫描确认，merge/h1/j/f）：{@code confirm()} / {@code cancel()}。
 * 桌面端无 UI，宿主（WebChromeClient）会自行确认，这里只需要可调用不炸。
 */
public class JsResult {

    protected JsResult() {
    }

    public final void confirm() {
    }

    public final void cancel() {
    }
}
