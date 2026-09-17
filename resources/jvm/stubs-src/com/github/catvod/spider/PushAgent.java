package com.github.catvod.spider;

import android.content.Context;

import com.github.catvod.crawler.Spider;
import com.github.catvod.crawler.SpiderDebug;

import org.json.JSONArray;
import org.json.JSONObject;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;
import org.jsoup.select.Elements;

import java.io.ByteArrayInputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 桌面移植版 PushAgent —— 推送/直链解析代理。
 *
 * <p>本类是**第三方 jar 自带的宿主类**：安卓官方的 CatVodTVSpider 里有它，
 * 但 FongMi/TV、TVBoxOS 等分支后来把它挪走了 / 没同步，导致依赖它的蜘蛛
 * （典型如 XBPQ）在桌面端一实例化就 ClassNotFoundException。
 *
 * <p>参考实现：CatVodTVOfficial/CatVodTVSpider 的
 * {@code app/src/main/java/com/github/catvod/spider/PushAgent.java}。
 *
 * <p>★ 适配取舍（不做 1:1 复刻的地方）：
 * <ul>
 *   <li><b>阿里云盘分支</b>（{@code getAliContent} / {@code refreshTk} /
 *       {@code ProxyMedia} / {@code listFiles}）：原版依赖 ali openapi + 阿里
 *       私有签名 + 宿主 Proxy.localProxyUrl()，桌面端无对应实现。这里保留
 *       同样签名但走 {@code 嗅探} 兜底分支，语义可接受（得到一个可播放链接
 *       或明确的空结果），而不是让蜘蛛整体炸掉。</li>
 *   <li>原版用 {@code OkHttpUtil}/{@code Misc}（CatVodTV 私有工具类，本 stub
 *       体系没有），这里改用 {@code com.github.catvod.net.OkHttp} + 本地
 *       isVip / isVideoFormat 内联判断。</li>
 *   <li>{@code android.net.UrlQuerySanitizer}、{@code android.text.TextUtils}
 *       在桌面端不存在，用 {@code String.join} / 手写解析替代。</li>
 * </ul>
 *
 * <p>同类命名冲突提醒：本类与安卓端同名类**签名必须一致**（蜘蛛字节码里是硬
 * 编码描述符），因此 {@code init(Context,String)} / {@code detailContent(List)}
 * / {@code playerContent(String,String,List)} 的形参类型不能改。
 */
public class PushAgent extends Spider {

    /** 阿里云盘分享链接特征。 */
    public static Pattern Folder = Pattern.compile("www.aliyundrive.com/s/([^/]+)(/folder/([^/]+))?");
    static final Pattern AliPLink = Pattern.compile("(https://www.aliyundrive.com/s/[^\"]+)");

    public static String Token = "";

    @Override
    public void init(Context context, String extend) {
        super.init(context, extend);
        try {
            if (extend == null) {
                Token = "";
            } else if (extend.startsWith("http")) {
                Token = com.github.catvod.net.OkHttp.string(extend, null);
            } else {
                Token = extend;
            }
        } catch (Throwable th) {
            Token = "";
        }
    }

    protected static long Time() {
        return System.currentTimeMillis() / 1000;
    }

    /**
     * 推送到详情页：把裸链变成一条合法的 vod 记录。
     * 分支顺序与原版保持一致（Vip → 腾讯 → 芒果 → 直连 → 磁力 → 阿里云盘 → 嗅探）。
     */
    @Override
    public String detailContent(List<String> list) {
        try {
            String url = list.get(0);
            Matcher aliMatcher = AliPLink.matcher(url);
            boolean isVipUrl = isVip(url);
            if (isVipUrl && !url.contains("qq.com") && !url.contains("mgtv.com")) {
                return oneItem(url, pageTitle(url, null), "官源", "jx", "立即播放$" + url,
                        "https://img.zcool.cn/community/0123545c74c5aea801213f261297df.png");
            }
            if (isVipUrl && url.contains("qq.com")) {
                List<String> items = new ArrayList<>();
                Document doc = Jsoup.parse(com.github.catvod.net.OkHttp.string(url, null));
                Elements playListA = doc.select("div.episode-list-rect__item");
                if (!playListA.isEmpty()) {
                    for (int i = 0; i < playListA.size(); i++) {
                        Element vod = playListA.get(i);
                        String a = vod.select("div").attr("data-vid");
                        String b = vod.select("div").attr("data-cid");
                        items.add(vod.select("div span").text() + "$https://v.qq.com/x/cover/" + b + "/" + a);
                    }
                    return oneItem(url, doc.select("head > title").text(), "腾讯TV", "jx",
                            join(items), "https://img2.baidu.com/it/u=2655029475,2190949369&fm=253&fmt=auto&app=138&f=JPEG?w=500&h=593");
                }
                return oneItem(url, doc.select("head > title").text(), "腾讯TV", "jx", "立即播放$" + url,
                        "https://img2.baidu.com/it/u=2655029475,2190949369&fm=253&fmt=auto&app=138&f=JPEG?w=500&h=593");
            }
            if (isVipUrl && url.contains("mgtv.com")) {
                List<String> items = new ArrayList<>();
                String title = "";
                Matcher mgtv = Pattern.compile("https://\\S+mgtv.com/b/(\\d+)/(\\d+).html.*").matcher(url);
                if (mgtv.find()) {
                    String ep = "https://pcweb.api.mgtv.com/episode/list?video_id=" + mgtv.group(2);
                    JSONObject data = new JSONObject(com.github.catvod.net.OkHttp.string(ep, null));
                    JSONObject d = data.getJSONObject("data");
                    title = d.getJSONObject("info").getString("title");
                    JSONArray arr = new JSONArray(d.getString("list"));
                    for (int i = 0; i < arr.length(); i++) {
                        JSONObject o = arr.getJSONObject(i);
                        if ("1".equals(o.optString("isIntact"))) {
                            items.add(o.optString("t4") + "$https://www.mgtv.com/b/" + mgtv.group(1)
                                    + "/" + o.optString("video_id") + ".html");
                        }
                    }
                }
                return oneItem(url, title, "芒果TV", "jx",
                        items.isEmpty() ? "立即播放$" + url : join(items),
                        "https://img2.baidu.com/it/u=2562822927,704100654&fm=253&fmt=auto&app=138&f=JPEG?w=600&h=380");
            }
            if (looksLikeVideoFormat(url)) {
                return oneItem(url, url, "直连", "player", "立即播放$" + url,
                        "https://img.zcool.cn/community/0123545c74c5aea801213f261297df.png");
            }
            if (url.startsWith("magnet")) {
                String name = url.length() > 100 ? url.substring(0, 30) + "..." + url.substring(url.length() - 10) : url;
                return oneItem(url, name, "磁力", "磁力测试", "立即播放$" + url,
                        "https://img2.baidu.com/it/u=1609185522,4130752057&fm=253&f=JPEG");
            }
            if (url.startsWith("http") && aliMatcher.find()) {
                // 桌面端不实现阿里云盘 openapi（见类注释的适配取舍），降级为嗅探。
                return oneItem(url, pageTitle(url, null), "嗅探", "嗅探", "立即播放嗅探$" + url,
                        "https://pic.rmb.bdstatic.com/bjh/1d0b02d0f57f0a42201f92caba5107ed.jpeg");
            }
            if (url.startsWith("http")) {
                return oneItem(url, pageTitle(url, null), "嗅探", "嗅探", "立即播放嗅探$" + url,
                        "https://pic.rmb.bdstatic.com/bjh/1d0b02d0f57f0a42201f92caba5107ed.jpeg");
            }
        } catch (Throwable th) {
            SpiderDebug.log(th);
        }
        return "";
    }

    @Override
    public String playerContent(String flag, String id, List<String> vipFlags) {
        try {
            JSONObject result = new JSONObject();
            switch (flag == null ? "" : flag) {
                case "jx":
                    result.put("parse", 1);
                    result.put("jx", "1");
                    result.put("url", id);
                    return result.toString();
                case "player":
                    result.put("parse", 0);
                    result.put("playUrl", "");
                    result.put("url", id);
                    return result.toString();
                case "嗅探":
                    result.put("parse", 1);
                    result.put("playUrl", "");
                    result.put("url", id);
                    return result.toString();
                default:
                    break;
            }
        } catch (Throwable th) {
            SpiderDebug.log(th);
        }
        return "";
    }

    /** 构造一条单集 vod 记录的 JSON（原版到处重复这段，这里收口）。 */
    private static String oneItem(String id, String name, String typeName, String playFrom, String playUrl, String pic) {
        try {
            JSONObject vod = new JSONObject();
            vod.put("vod_id", id);
            vod.put("vod_name", name == null ? "" : name);
            vod.put("vod_pic", pic);
            vod.put("type_name", typeName);
            vod.put("vod_year", "");
            vod.put("vod_area", "");
            vod.put("vod_remarks", "");
            vod.put("vod_actor", "");
            vod.put("vod_director", "");
            vod.put("vod_content", id);
            vod.put("vod_play_from", playFrom);
            vod.put("vod_play_url", playUrl);
            JSONArray lists = new JSONArray();
            lists.put(vod);
            JSONObject result = new JSONObject();
            result.put("list", lists);
            return result.toString();
        } catch (Throwable th) {
            return "";
        }
    }

    private static String pageTitle(String url, Map<String, String> headers) {
        try {
            Document doc = Jsoup.parse(com.github.catvod.net.OkHttp.string(url, headers));
            return doc.select("head > title").text();
        } catch (Throwable th) {
            return url;
        }
    }

    private static String join(List<String> items) {
        return String.join("#", items);
    }

    /** 官方解析（vip 视频平台），与原版 CatVodTV Misc.isVip 口径一致。 */
    private static boolean isVip(String url) {
        if (url == null) return false;
        List<String> hosts = java.util.Arrays.asList(
                "360kan.com", "v.qq.com", "mgtv.com", "iqiyi.com", "youku.com", "le.com",
                "sohu.com", "tudou.com", "pptv.com", "bilibili.com", "1905.com", "qiyi.com",
                "miguvideo.com", "pplive.com", "wasu.cn");
        for (String h : hosts) if (url.contains(h)) return true;
        return false;
    }

    /** 直链视频格式判断，与原版 CatVodTV Misc.isVideoFormat 口径一致。 */
    private static boolean looksLikeVideoFormat(String url) {
        if (url == null) return false;
        String u = url.toLowerCase();
        return u.contains(".m3u8") || u.contains(".mp4") || u.contains(".mkv") || u.contains(".avi")
                || u.contains(".flv") || u.contains(".ts") || u.contains(".m4a") || u.contains(".mp3")
                || u.contains(".rmvb") || u.contains(".wmv") || u.contains(".mov");
    }

    /** 供 XBPQ 等蜘蛛以静态方式引用（原版为 public static）。 */
    public static Object[] vod(Map<String, String> map) {
        return null;
    }

    public static Object[] getFile(Map<String, String> map) {
        return null;
    }

    public static Object[] ProxyMedia(Map<String, String> map) {
        return null;
    }

    public String getAliContent(List<String> list) {
        return detailContent(list);
    }

    public void listFiles(Map<String, String> map, String str, String str2, String str3) {
    }

    @SuppressWarnings("unused")
    private static ByteArrayInputStream unusedKeepImport() {
        return null;
    }

    @SuppressWarnings("unused")
    private static HashMap<String, String> unusedKeepImport2() {
        return null;
    }
}
