package android.webkit;

/**
 * SslErrorHandler stub —— SSL 证书错误处理器。
 *
 * <p>真实调用面（扫描确认，merge/h1/j/g <b>WebViewClient.onReceivedSslError</b>）：
 * {@code proceed()} / {@code cancel()}。
 *
 * <p>★ 这里必须调用 {@code proceed()} 才符合桌面端语义：蜘蛛内嵌的浏览器组件
 * 经常遇到自签名/过期证书的源站，安卓上用户点"继续"即可；桌面端无人值守，
 * 直接 proceed（等价于 OkHttp 里我们已设置的 TrustManager 全放行）。
 */
public class SslErrorHandler extends android.os.Handler {

    public SslErrorHandler() {
        super();
    }

    public void proceed() {
    }

    public void cancel() {
    }
}
