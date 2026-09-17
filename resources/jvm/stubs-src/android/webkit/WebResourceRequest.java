package android.webkit;

/** WebResourceRequest stub（WebView 拦截请求时蜘蛛读 url；桌面版无真实 WebView）。 */
public interface WebResourceRequest {
    android.net.Uri getUrl();
    boolean isForMainFrame();
    boolean hasGesture();
    boolean isRedirect();
    String getMethod();
    java.util.Map<String, String> getRequestHeaders();
}
