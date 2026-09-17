package android.net.http;

/**
 * SslError stub —— SSL 证书错误（旧版 net.http 包，安卓 API 14+ 已迁移到
 * {@code android.net.http.SslError} 但类名保留）。
 *
 * <p>真实调用面（扫描确认，merge/h1/j/g.WebViewClient#onReceivedSslError 第三个参数）：
 * {@code getPrimaryError()} / {@code getUrl()} / {@code getCertificate()} 等。
 * 桌面端不产生该对象，仅保证类型存在且 getter 不抛。
 */
public class SslError {

    public static final int SSL_NOTYETVALID = 0;
    public static final int SSL_EXPIRED = 1;
    public static final int SSL_IDMISMATCH = 2;
    public static final int SSL_UNTRUSTED = 3;
    public static final int SSL_DATE_INVALID = 4;
    public static final int SSL_INVALID = 5;

    protected SslError() {
    }

    public int getPrimaryError() {
        return SSL_INVALID;
    }

    public boolean hasError(int error) {
        return false;
    }

    public String getUrl() {
        return "";
    }

    public android.net.http.SslCertificate getCertificate() {
        return null;
    }

    public void addError(int error) {
    }

    @Override
    public String toString() {
        return "";
    }
}
