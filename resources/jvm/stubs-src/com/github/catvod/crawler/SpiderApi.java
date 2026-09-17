package com.github.catvod.crawler;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import okhttp3.FormBody;
import okhttp3.Headers;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * 桌面移植版 SpiderApi —— 宿主能力门面。
 *
 * <p>契约来源：q215613905/TVBoxOS 的
 * {@code app/src/main/java/com/github/catvod/crawler/Spider.java#initApi(SpiderApi)}。
 * 安卓原版把 Activity/ControlManager/App 等宿主对象暴露给蜘蛛；桌面端没有这些，
 * 因此本类**逐个方法降级**，宁可返回空串也绝不抛异常 —— 蜘蛛侧通常直接
 * {@code api.log(...)} / {@code api.getAddress(...)} 而不做 try/catch。
 *
 * <p>设计原则（见项目 stub 三原则）：
 * <ul>
 *   <li>能力入口绝不返回 null —— 返回 "" 或空实现，让蜘蛛的字符串拼接不炸。</li>
 *   <li>网络类方法（multiReq）用真实实现 —— 这是 SpiderApi 里唯一有实际业务
 *       价值的接口，很多新版蜘蛛靠它并发拉取多个接口。</li>
 *   <li>宿主类方法（getAddress/getPort/getScreenOrientation）安全兜底 —— 桌面端
 *       无内置 http 服务，返回回环地址即可，蜘蛛一般只用来拼图片代理 URL。</li>
 * </ul>
 */
public class SpiderApi {

    /** 桌面端没有内置 ControlManager HTTP 服务，统一返回回环地址。 */
    private static final String LOOPBACK = "http://127.0.0.1:9978";

    public String getAddress(boolean local) {
        try {
            return LOOPBACK;
        } catch (Throwable th) {
            return "";
        }
    }

    public String getPort() {
        try {
            int idx = LOOPBACK.lastIndexOf(":");
            return idx >= 0 ? LOOPBACK.substring(idx + 1).replace("/", "") : "";
        } catch (Throwable th) {
            return "";
        }
    }

    public void log(String msg) {
        try {
            SpiderDebug.log(msg);
        } catch (Throwable ignored) {
        }
    }

    /**
     * 安卓原版返回屏幕方向常量（ActivityInfo.SCREEN_ORIENTATION_*）。
     * 桌面端恒为横屏，返回 SCREEN_ORIENTATION_LANDSCAPE(0)，与竖屏常量
     * 区分开且是蜘蛛最容易接受的值。
     */
    public int getScreenOrientation() {
        return 0;
    }

    /**
     * 并发请求多个接口。数组元素形如
     * {@code {"url":"...","method":"GET|POST","headers":{...},"data":...,"postType":"form|json"}}，
     * 返回与输入等长的 JSON 数组；元素为可解析 JSON 时返回对象/数组，否则返回字符串。
     */
    public String multiReq(JsonArray array) {
        try {
            if (array == null || array.size() == 0) return "";
            ExecutorService executor = Executors.newFixedThreadPool(Math.min(array.size(), 6));
            ArrayList<Future<String>> futures = new ArrayList<>();
            for (JsonElement element : array) {
                if (!element.isJsonObject()) continue;
                JsonObject obj = element.getAsJsonObject();
                futures.add(executor.submit(() -> request(obj)));
            }
            JsonArray result = new JsonArray();
            for (Future<String> future : futures) result.add(toResult(future.get()));
            executor.shutdown();
            return result.toString();
        } catch (Throwable th) {
            return "";
        }
    }

    /**
     * 把 URL 包装成宿主解析协议链接。桌面端没有 SuperParse 播放器，
     * 但保持与原版**逐字节一致**的输出格式 —— 蜘蛛可能对它做字符串判断。
     */
    public String webParse(String url, String flag) {
        try {
            if (url == null || url.isEmpty()) return "";
            String encoded = Base64.getUrlEncoder().withoutPadding()
                    .encodeToString(url.getBytes(StandardCharsets.UTF_8));
            return "proxy://go=SuperParse&flag=" + (flag == null ? "" : flag) + "&url=" + encoded;
        } catch (Throwable th) {
            return "";
        }
    }

    private static String request(JsonObject obj) {
        try {
            String url = string(obj, "url");
            if (url.isEmpty()) return "";
            String method = string(obj, "method");
            Headers headers = headers(obj.get("headers"));
            Request.Builder builder = new Request.Builder().url(url).headers(headers);
            if ("POST".equalsIgnoreCase(method)) builder.post(body(obj));
            OkHttpClient client = com.github.catvod.net.OkHttp.client();
            try (Response response = client.newCall(builder.build()).execute()) {
                return response.body() != null ? response.body().string() : "";
            }
        } catch (Throwable th) {
            return "";
        }
    }

    private static JsonElement toResult(String text) {
        if (text == null) return new JsonPrimitive("");
        try {
            String trim = text.trim();
            if (trim.startsWith("{") || trim.startsWith("[")) {
                return JsonParser.parseString(trim);
            }
        } catch (Throwable ignored) {
        }
        return new JsonPrimitive(text);
    }

    private static RequestBody body(JsonObject obj) {
        JsonElement data = obj.get("data");
        if (data == null || data.isJsonNull()) return RequestBody.create(null, "");
        String postType = string(obj, "postType");
        if ("form".equalsIgnoreCase(postType) && data.isJsonObject()) {
            FormBody.Builder builder = new FormBody.Builder();
            for (Map.Entry<String, JsonElement> entry : data.getAsJsonObject().entrySet()) {
                builder.add(entry.getKey(), entry.getValue().getAsString());
            }
            return builder.build();
        }
        return RequestBody.create(null, data.isJsonPrimitive() ? data.getAsString() : data.toString());
    }

    private static Headers headers(JsonElement element) {
        try {
            if (element == null || element.isJsonNull() || !element.isJsonObject()) {
                return new Headers.Builder().build();
            }
            HashMap<String, String> map = new HashMap<>();
            for (Map.Entry<String, JsonElement> entry : element.getAsJsonObject().entrySet()) {
                map.put(entry.getKey(), entry.getValue().getAsString());
            }
            return Headers.of(map);
        } catch (Throwable th) {
            return new Headers.Builder().build();
        }
    }

    private static String string(JsonObject obj, String key) {
        JsonElement element = obj.get(key);
        return element == null || element.isJsonNull() ? "" : element.getAsString();
    }
}
