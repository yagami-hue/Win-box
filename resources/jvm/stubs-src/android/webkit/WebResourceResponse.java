package android.webkit;

import java.io.InputStream;
import java.util.Map;

/**
 * WebResourceResponse stub —— WebView 拦截请求后返回的自定义响应。
 *
 * <p>真实调用面（扫描确认，Nmyswv 系蜘蛛用 shouldInterceptRequest 返回自定义响应）：
 * 构造器 {@code (String mimeType, String encoding, InputStream data)}，
 * 以及 {@code setStatusCode(int)} / {@code setReasonPhrase(String)} /
 * {@code setResponseHeaders(Map)} / {@code setStatusCodeAndReasonPhrase(int,String)}。
 *
 * <p>★ 这是**数据承载类**，必须真实保存字段：蜘蛛构造后由宿主 WebView 读出来
 * 把内容喂给页面。做成空壳会让内容静默丢失（不是崩溃，是"看着没报错但没数据"，
 * 最难排查的那类）。
 */
public class WebResourceResponse {

    private String mMimeType;
    private String mEncoding;
    private InputStream mData;
    private int mStatusCode = 200;
    private String mReasonPhrase = "OK";
    private Map<String, String> mResponseHeaders;

    public WebResourceResponse(String mimeType, String encoding, InputStream data) {
        this.mMimeType = mimeType;
        this.mEncoding = encoding;
        this.mData = data;
    }

    public WebResourceResponse(String mimeType, String encoding, int statusCode, String reasonPhrase, Map<String, String> responseHeaders, InputStream data) {
        this.mMimeType = mimeType;
        this.mEncoding = encoding;
        this.mStatusCode = statusCode;
        this.mReasonPhrase = reasonPhrase;
        this.mResponseHeaders = responseHeaders;
        this.mData = data;
    }

    protected WebResourceResponse() {
    }

    public InputStream getData() {
        return mData;
    }

    public void setData(InputStream data) {
        this.mData = data;
    }

    public String getMimeType() {
        return mMimeType;
    }

    public void setMimeType(String mimeType) {
        this.mMimeType = mimeType;
    }

    public String getEncoding() {
        return mEncoding;
    }

    public void setEncoding(String encoding) {
        this.mEncoding = encoding;
    }

    public void setStatusCode(int statusCode) {
        this.mStatusCode = statusCode;
    }

    public int getStatusCode() {
        return mStatusCode;
    }

    public void setReasonPhrase(String reasonPhrase) {
        this.mReasonPhrase = reasonPhrase;
    }

    public String getReasonPhrase() {
        return mReasonPhrase;
    }

    public void setStatusCodeAndReasonPhrase(int statusCode, String reasonPhrase) {
        this.mStatusCode = statusCode;
        this.mReasonPhrase = reasonPhrase;
    }

    public Map<String, String> getResponseHeaders() {
        return mResponseHeaders;
    }

    public void setResponseHeaders(Map<String, String> headers) {
        this.mResponseHeaders = headers;
    }
}
