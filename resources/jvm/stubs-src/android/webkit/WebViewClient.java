package android.webkit;

import android.graphics.Bitmap;
import android.net.http.SslError;
import android.os.Message;
import android.view.KeyEvent;

/**
 * WebViewClient stub —— WebView 的页面生命周期/请求拦截回调。
 *
 * <p>★ 本类在基线 jar 里已存在（只有 shouldOverrideUrlLoading / onPageFinished
 * 两个方法），但内嵌 WebView 库（merge/h1/j/g）覆写了更多回调 → 触发
 * "does not override" VerifyError。这里做**超集重写**：保留原有两个方法签名
 * 不变，补齐安卓 API 28 的回调全集。
 *
 * <p>签名必须逐字节匹配安卓原版：桌面端这些方法一律返回"不拦截 / 不处理"，
 * 让蜘蛛自身的逻辑继续走它自己的 HTTP 通道（而不是依赖 WebView）。
 */
public class WebViewClient {

    public WebViewClient() {
    }

    public boolean shouldOverrideUrlLoading(WebView view, String url) {
        return false;
    }

    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        return false;
    }

    public void onPageStarted(WebView view, String url, Bitmap favicon) {
    }

    public void onPageFinished(WebView view, String url) {
    }

    public void onLoadResource(WebView view, String url) {
    }

    public void onPageCommitVisible(WebView view, String url) {
    }

    @Deprecated
    public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
        return null;
    }

    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        return null;
    }

    @Deprecated
    public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
    }

    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
    }

    public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
    }

    public void onFormResubmission(WebView view, Message dontResend, Message resend) {
    }

    public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
    }

    public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
        // 桌面端与本项目 OkHttp 的信任策略保持一致：放行，避免源站证书问题导致整条链断掉。
        if (handler != null) handler.proceed();
    }

    public void onReceivedClientCertRequest(WebView view, ClientCertRequest request) {
    }

    public void onReceivedHttpAuthRequest(WebView view, HttpAuthHandler handler, String host, String realm) {
    }

    public boolean shouldOverrideKeyEvent(WebView view, KeyEvent event) {
        return false;
    }

    public void onUnhandledKeyEvent(WebView view, KeyEvent event) {
    }

    public void onScaleChanged(WebView view, float oldScale, float newScale) {
    }

    public void onReceivedLoginRequest(WebView view, String realm, String account, String args) {
    }

    /**
     * 客户端证书请求（安卓 API 21+）。桌面端无客户端证书，直接 cancel 语义。
     */
    public static class ClientCertRequest {
        public void proceed(java.security.PrivateKey privateKey, java.security.cert.X509Certificate[] chain) {
        }

        public void cancel() {
        }

        public void ignore() {
        }

        public String getHost() {
            return "";
        }

        public int getPort() {
            return 0;
        }

        public String[] getKeyTypes() {
            return new String[0];
        }

        public java.security.Principal[] getPrincipals() {
            return new java.security.Principal[0];
        }
    }

    /** HTTP 认证请求（401/407）。桌面端 no-op + 返回 false 表示不处理。 */
    public static class HttpAuthHandler {
        public void proceed(String username, String password) {
        }

        public void cancel() {
        }

        public boolean useHttpAuthUsernamePassword() {
            return false;
        }
    }
}
