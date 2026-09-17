package com.github.catvod.crawler;

import android.content.Context;

import com.github.catvod.net.OkHttp;

import org.json.JSONObject;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import okhttp3.Dns;
import okhttp3.OkHttpClient;

/**
 * 桌面移植版 Spider 基类。
 *
 * <p>字节码契约必须与安卓原版逐字段一致 —— 蜘蛛 dex2jar 产物里对基类成员的
 * 引用是**硬编码的描述符**，少一个字段就是 NoSuchFieldError，少一个方法就是
 * NoSuchMethodError（比 ClassNotFoundException 更隐蔽，往往表现为蜘蛛内部
 * 莫名的 NPE）。
 *
 * <p>★ 本类此前由基线 jar 直接提供、没有源码，导致 {@code initApi(SpiderApi)}
 * 缺失 → XBPQ 等新版蜘蛛一启动就 ClassNotFoundException/NoSuchMethodError。
 * 现在纳入源码统一管理，与 TVBoxOS(q215613905) 的 Spider.java 保持签名一致。
 */
public class Spider {

    public static JSONObject empty = new JSONObject();
    public String siteKey;

    protected static Context mContext;

    public void init(Context context) {
        mContext = context;
    }

    public void init(Context context, String extend) {
        init(context);
    }

    /**
     * 宿主能力注入点。安卓原版为空实现，由 SpiderRunner 反射调用；
     * 蜘蛛自己覆写此方法保存 api 引用（典型写法：
     * {@code private SpiderApi api; public void initApi(SpiderApi api){ this.api = api; }}）。
     */
    public void initApi(SpiderApi api) {
    }

    public String homeContent(boolean filter) {
        return "";
    }

    public String homeVideoContent() {
        return "";
    }

    public String categoryContent(String tid, String pg, boolean filter, HashMap<String, String> extend) {
        return "";
    }

    public String detailContent(List<String> ids) {
        return "";
    }

    public String searchContent(String key, boolean quick) {
        return "";
    }

    public String searchContent(String key, boolean quick, String pg) {
        return searchContent(key, quick);
    }

    public String playerContent(String flag, String id, List<String> vipFlags) {
        return "";
    }

    public boolean isVideoFormat(String url) {
        return false;
    }

    public boolean manualVideoCheck() {
        return false;
    }

    public String liveContent(String url) {
        return "";
    }

    public static Dns safeDns() {
        return OkHttp.dns();
    }

    public static OkHttpClient client() {
        return OkHttp.client();
    }

    public void cancelByTag() {
    }

    public void destroy() {
    }

    public Object[] proxyLocal(Map<String, String> params) {
        return null;
    }

    public Object[] proxy(Map<String, String> params) {
        return proxyLocal(params);
    }

    public String action(String action) {
        return null;
    }
}
