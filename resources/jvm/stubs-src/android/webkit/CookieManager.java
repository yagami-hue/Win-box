package android.webkit;

import android.content.Context;

/**
 * CookieManager stub —— cookie 存取门面。
 *
 * <p>真实调用面（扫描确认，merge/h1/j/k 内嵌 WebView 库）：{@code getInstance()}、
 * {@code getCookie(String)}、{@code setCookie(String,String)}、{@code removeAllCookies}、
 * {@code setAcceptCookie(boolean)}、{@code flush()}。
 *
 * <p>桌面端没有 WebView cookie 存储，但要**真实记住 setCookie 的值**：某些蜘蛛
 * 先 setCookie 再 getCookie 校验（写读回环），恒返回 null 会让它误判登录失败。
 * 用一个进程内 HashMap 兜住即可。
 */
public class CookieManager {

    private static volatile CookieManager sInstance;
    private final java.util.Map<String, String> mCookies = new java.util.concurrent.ConcurrentHashMap<>();

    protected CookieManager() {
    }

    public static CookieManager getInstance() {
        if (sInstance == null) {
            synchronized (CookieManager.class) {
                if (sInstance == null) sInstance = new CookieManager();
            }
        }
        return sInstance;
    }

    public void setCookie(String url, String value) {
        if (url == null) return;
        mCookies.put(url, value == null ? "" : value);
    }

    public void setCookie(String url, String value, ValueCallback<Boolean> callback) {
        setCookie(url, value);
        if (callback != null) callback.onReceiveValue(Boolean.TRUE);
    }

    public String getCookie(String url) {
        if (url == null) return null;
        String v = mCookies.get(url);
        if (v != null) return v;
        // 退化为按 host 前缀匹配（安卓真实实现也是按域匹配的）
        for (java.util.Map.Entry<String, String> e : mCookies.entrySet()) {
            if (url.startsWith(e.getKey()) || e.getKey().startsWith(url)) return e.getValue();
        }
        return null;
    }

    public boolean hasCookies() {
        return !mCookies.isEmpty();
    }

    public void removeAllCookies(ValueCallback<Boolean> callback) {
        mCookies.clear();
        if (callback != null) callback.onReceiveValue(Boolean.TRUE);
    }

    public void removeSessionCookies(ValueCallback<Boolean> callback) {
        if (callback != null) callback.onReceiveValue(Boolean.TRUE);
    }

    public void removeAllCookie() {
        mCookies.clear();
    }

    public void removeSessionCookie() {
    }

    public void setAcceptCookie(boolean accept) {
    }

    public boolean acceptCookie() {
        return true;
    }

    public void setAcceptThirdPartyCookies(WebView webview, boolean accept) {
    }

    public boolean acceptThirdPartyCookies(WebView webview) {
        return true;
    }

    public void flush() {
    }

    public static boolean allowFileSchemeCookies() {
        return true;
    }

    public static void setAcceptFileSchemeCookies(boolean accept) {
    }

    public void removeCookies(String url) {
        mCookies.remove(url);
    }

    public void removeCookies(String url, ValueCallback<Boolean> callback) {
        mCookies.remove(url);
        if (callback != null) callback.onReceiveValue(Boolean.TRUE);
    }

    /** 供宿主（Context 相关 API）显式 no-op，避免静态导入报错。 */
    public void setCookie(Context context, String url, String value) {
        setCookie(url, value);
    }
}
