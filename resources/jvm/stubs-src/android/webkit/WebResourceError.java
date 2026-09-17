package android.webkit;

/**
 * WebResourceError stub —— 资源加载错误的描述。
 *
 * <p>真实调用面（扫描确认，merge/h1/j/g.WebViewClient#onReceivedError）：
 * {@code getErrorCode()} / {@code getDescription()}。
 * 桌面端不产生该对象（WebViewClient 是空壳），仅保证类型存在 + getter 不抛。
 */
public interface WebResourceError {
    CharSequence getDescription();
    int getErrorCode();
}
