package android.webkit;

import android.content.Context;
import android.graphics.Bitmap;
import android.os.Message;
import android.view.View;
import android.view.ViewGroup;

import java.util.Map;

/**
 * WebView stub —— 内嵌浏览器控件（超集重写）。
 *
 * <p>★ 基线 jar 已有本类（构造器 + getSettings/loadUrl/setWebViewClient/
 * evaluateJavascript），但内嵌 WebView 库还会调 {@code addJavascriptInterface} /
 * {@code setWebChromeClient} / {@code loadDataWithBaseURL} / {@code stopLoading} 等，
 * 缺一个就是 NoSuchMethodError。这里补齐安卓 API 28 的常用方法面。
 *
 * <p>桌面端没有真实渲染引擎：{@code loadUrl} 之类只记录状态（供蜘蛛读取），
 * 不真正发起导航 —— 蜘蛛应当走自己的 OkHttp 通道取数据，WebView 只是它的兜底。
 */
public class WebView extends ViewGroup {

    private String mUrl = "";
    private String mUa = "";
    private WebViewClient mWebViewClient;
    private WebChromeClient mWebChromeClient;
    private final WebSettings mSettings;
    private final Map<String, Object> mJsInterfaces = new java.util.concurrent.ConcurrentHashMap<>();
    private View mCustomView;

    public WebView(Context context) {
        super(context);
        mSettings = new WebSettings();
    }

    public WebView(Context context, android.util.AttributeSet attrs) {
        this(context);
    }

    public WebSettings getSettings() {
        return mSettings;
    }

    public void setWebViewClient(WebViewClient client) {
        this.mWebViewClient = client;
    }

    public WebViewClient getWebViewClient() {
        return mWebViewClient;
    }

    public void setWebChromeClient(WebChromeClient client) {
        this.mWebChromeClient = client;
    }

    public WebChromeClient getWebChromeClient() {
        return mWebChromeClient;
    }

    public String getUrl() {
        return mUrl;
    }

    public String getOriginalUrl() {
        return mUrl;
    }

    public String getTitle() {
        return "";
    }

    public void loadUrl(String url) {
        loadUrl(url, null);
    }

    public void loadUrl(String url, Map<String, String> additionalHttpHeaders) {
        this.mUrl = url == null ? "" : url;
    }

    public void postUrl(String url, byte[] postData) {
        this.mUrl = url == null ? "" : url;
    }

    public void loadData(String data, String mimeType, String encoding) {
    }

    public void loadDataWithBaseURL(String baseUrl, String data, String mimeType, String encoding, String historyUrl) {
        if (baseUrl != null) this.mUrl = baseUrl;
    }

    public void reload() {
    }

    public void stopLoading() {
    }

    public void clearHistory() {
    }

    public void clearCache(boolean includeDiskFiles) {
    }

    public void clearFormData() {
    }

    public void clearSslPreferences() {
    }

    public boolean canGoBack() {
        return false;
    }

    public boolean canGoForward() {
        return false;
    }

    public void goBack() {
    }

    public void goForward() {
    }

    public int getProgress() {
        return 100;
    }

    public int getContentHeight() {
        return 0;
    }

    public void addJavascriptInterface(Object obj, String interfaceName) {
        if (interfaceName != null) mJsInterfaces.put(interfaceName, obj);
    }

    public void removeJavascriptInterface(String interfaceName) {
        if (interfaceName != null) mJsInterfaces.remove(interfaceName);
    }

    public void evaluateJavascript(String script, ValueCallback<String> resultCallback) {
        if (resultCallback != null) resultCallback.onReceiveValue("");
    }

    @Deprecated
    public void setJavaScriptEnabled(boolean flag) {
        if (mSettings != null) mSettings.setJavaScriptEnabled(flag);
    }

    public void setInitialScale(int scaleInPercent) {
    }

    public void setNetworkAvailable(boolean networkUp) {
    }

    public void setUserAgentString(String ua) {
        this.mUa = ua == null ? "" : ua;
    }

    public String getUserAgentString() {
        return mUa;
    }

    public void setBackgroundColor(int color) {
    }

    public void setOnLongClickListener(View.OnLongClickListener l) {
    }

    public void destroy() {
        mWebViewClient = null;
        mWebChromeClient = null;
        mJsInterfaces.clear();
        mCustomView = null;
    }

    public View getCustomView() {
        return mCustomView;
    }

    public void setCustomView(View view) {
        this.mCustomView = view;
    }

    public boolean isCustomViewShowing() {
        return mCustomView != null;
    }

    public void requestFocusNodeHref(Message msg) {
    }

    public void saveWebArchive(String filename) {
    }

    public void pauseTimers() {
    }

    public void resumeTimers() {
    }

    public void onPause() {
    }

    public void onResume() {
    }

    public boolean onKeyDown(int keyCode, android.view.KeyEvent event) {
        return false;
    }

    public static void setWebContentsDebuggingEnabled(boolean enabled) {
    }

    public static String getDefaultUserAgent(Context context) {
        return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
    }

    @SuppressWarnings("unused")
    private Bitmap unusedBitmapRef() {
        return null;
    }
}
