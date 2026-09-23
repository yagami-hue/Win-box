import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.lang.reflect.Method;
import java.net.URL;
import java.net.URLClassLoader;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.LinkedHashMap;

/**
 * 桌面版 Spider 运行器 —— 等效 DexClassLoader 的宿主侧。
 * 用法:
 *   一次性: SpiderRunner <spiderJar>[;<jar2>...] <className> <method> [args...]
 *   常驻:   SpiderRunner --serve <spiderJar>[;<jar2>...]
 * 结果 JSON 打到 stdout；错误/日志走 stderr。
 *
 * ★ 常驻(--serve)协议（进程池复用核心）：环境只初始化一次（URLClassLoader + Init/App 单例），
 *   然后循环从 stdin 读 JSON 行请求：
 *     {"id": "...", "className": "com.github.catvod.spider.Xxx", "method": "homeContent", "args": ["ext", ...]}
 *   每请求 new 一个蜘蛛实例（复用 JVM、不复用实例，避免跨请求状态串扰），
 *   结果以**单行 JSON 信封**写 stdout 并 flush：
 *     {"id":"...", "ok":true|false, "data":"结果JSON字符串"}
 *   data 经 Gson 序列化（内嵌 \n 被转义为 \\n），物理单行，行协议不被结果内容打穿。
 *   读到 EOF 或 "quit" 行退出。
 */
public class SpiderRunner {

  public static void main(String[] args) {
    // ★ stdout 专供「结果/信封」：蜘蛛自己的 System.out.println 会与结果/信封共用同一管道，
    //   打印碎片（不带换行的半行）+ 信封 → 整行 JSON 解析失败 → 常驻池侧挂起到超时
    //   （用户侧表现「半天搜不出来」）。这里把 System.out 重定向到 stderr，
    //   结果与信封一律走 realOut（stderr 由宿主消费，既防管道写满也保留 SpiderLog 诊断）。
    PrintStream realOut = System.out;
    System.setOut(System.err);
    int code = 0;
    try {
      // ★ 常驻模式：--serve <jars;...>（环境只初始化一次，服务多请求）
      if (args.length >= 2 && "--serve".equals(args[0])) {
        serve(args[1].split(";"), realOut);
        return; // serve 靠 EOF / quit 自然返回，不 System.exit（保持 JVM 退出码 0）
      }
      if (args.length < 3) throw new IllegalArgumentException("usage: SpiderRunner <jars;...> <className> <method> [args...]");
      String[] jars = args[0].split(";");
      Env env = setupEnv(jars);
      String result = dispatch(env, args[1], args[2],
          args.length > 3 ? Arrays.copyOfRange(args, 3, args.length) : new String[0], null);
      realOut.println(result == null ? "" : result);
    } catch (Throwable t) {
      Throwable cause = unwrap(t);
      System.err.println("[SpiderRunner.ERROR] " + cause.getClass().getName() + ": " + cause.getMessage());
      StackTraceElement[] st = cause.getStackTrace();
      for (int i = 0; i < Math.min(6, st.length); i++) System.err.println("    at " + st[i]);
      code = 1;
    }
    System.exit(code);
  }

  /**
   * 常驻服务：读 stdin JSON 行 → **提交到线程池并发执行** → 单行 JSON 信封应答（realOut 专用）。
   *
   * ★★ 2026-09-23 三轮重做（用户反馈「进源加载慢得要死、搜索更慢」）★★
   *   旧实现两个致命点：
   *     ① **串行**：一个 JVM 同时只处理一个请求 → 33 个源要么排队（慢），要么靠多开 JVM 换并行度
   *        （每个 JVM 冷启动 1~3s + 84MB，且首次搜索要同时冷启 6 个 → 磁盘/CPU/杀软齐打，越搜越慢）；
   *     ② **每请求 new 实例 + init(ext) + initApi**：绝大数 fty 蜘蛛的 init 会解析/解密 ext、
   *        建 HTTP 客户端甚至预取站点数据 —— 每次调用都重付一遍，进源/搜索自然慢。
   *   现在：线程池（24 线程并发，蜘蛛调用绝大多数时间在等网络）+ **实例池复用**
   *   （同一「类名+ext」最多 2 个实例：init 只做一次，并发调用各取一个；池满则临时实例兜底）。
   *   对齐安卓 TVBox 的 SpiderManager（那里就是一个站点一个长期存活的实例）。
   */
  private static void serve(String[] jars, PrintStream realOut) throws Exception {
    final Env env = setupEnv(jars);
    final com.google.gson.Gson gson = new com.google.gson.Gson();
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in, "UTF-8"));
    String line;
    while ((line = in.readLine()) != null) {
      String t = line.trim();
      if (t.isEmpty()) continue;
      if ("quit".equals(t)) break;
      String reqId = "";
      String cls = "";
      String method = "";
      String[] args = new String[0];
      try {
        com.google.gson.JsonObject req = gson.fromJson(t, com.google.gson.JsonObject.class);
        reqId = req.has("id") ? req.get("id").getAsString() : "";
        cls = req.get("className").getAsString();
        method = req.get("method").getAsString();
        List<String> argList = new ArrayList<String>();
        com.google.gson.JsonArray arr = req.has("args") && req.get("args").isJsonArray() ? req.getAsJsonArray("args") : null;
        if (arr != null) for (int i = 0; i < arr.size(); i++) argList.add(arr.get(i).isJsonNull() ? "" : arr.get(i).getAsString());
        args = argList.toArray(new String[0]);
      } catch (Throwable t0) {
        writeEnvelope(realOut, gson, reqId, false, "bad request: " + t0);
        continue;
      }
      // ★ 预热探针（池 warm）：env 已在 serve 入口 setupEnv 完成，无需实例化蜘蛛。
      if ("__ping__".equals(method)) {
        writeEnvelope(realOut, gson, reqId, true, "");
        continue;
      }
      final String fId = reqId;
      final String fCls = cls;
      final String fMethod = method;
      final String[] fArgs = args;
      WORKERS.submit(new Runnable() {
        @Override public void run() {
          boolean ok = false;
          String data = "";
          Object sp = null;
          try {
            sp = SpiderPool.acquire(env, fCls, fArgs);
            data = dispatchMethod(sp, fMethod, fArgs);
            ok = true;
          } catch (Throwable t0) {
            Throwable cause = unwrap(t0);
            data = cause.getClass().getName() + ": " + cause.getMessage();
            StackTraceElement[] st = cause.getStackTrace();
            for (int i = 0; i < Math.min(4, st.length); i++) System.err.println("    at " + st[i]);
          } finally {
            // 复用实例（异常时丢弃：可能已被打断到不可用状态，下次重建更稳）
            if (sp != null) SpiderPool.release(fCls, fArgs, sp, !ok);
          }
          writeEnvelope(realOut, gson, fId, ok, data);
        }
      });
    }
    WORKERS.shutdown();
  }

  /** 并发工作线程池（蜘蛛调用是「等网络」，线程数给足；守护线程不阻塞 JVM 退出） */
  private static final java.util.concurrent.ExecutorService WORKERS =
      java.util.concurrent.Executors.newFixedThreadPool(24, new java.util.concurrent.ThreadFactory() {
        @Override public Thread newThread(Runnable r) {
          Thread th = new Thread(r, "spider-call");
          th.setDaemon(true);
          return th;
        }
      });

  /** 单行信封（多线程并发写同一 stdout → 必须同步，避免两行交错成半个 JSON） */
  private static void writeEnvelope(PrintStream realOut, com.google.gson.Gson gson, String id, boolean ok, String data) {
    LinkedHashMap<String, Object> out = new LinkedHashMap<String, Object>();
    out.put("id", id);
    out.put("ok", ok);
    out.put("data", data == null ? "" : data);
    String s = gson.toJson(out);
    synchronized (realOut) {
      realOut.println(s);
      realOut.flush();
    }
  }

  /**
   * ★ 实例池：键 = 类名 + ext（ext 变 = 网盘 token/配置变了 → 必须换实例）。
   * 每键最多 MAX 个实例常驻；都被占用时新建「临时实例」（用完即弃，不干扰池内状态）。
   */
  private static final class SpiderPool {
    static final int MAX = 2;
    static final java.util.concurrent.ConcurrentHashMap<String, Entry> MAP =
        new java.util.concurrent.ConcurrentHashMap<String, Entry>();

    static final class Entry {
      final java.util.ArrayDeque<Object> free = new java.util.ArrayDeque<Object>();
      int made;
    }

    static String keyOf(String cls, String[] rest) {
      return cls + '\u0001' + (rest.length > 0 && rest[0] != null ? rest[0] : "");
    }

    static Object acquire(Env env, String cls, String[] rest) throws Exception {
      String key = keyOf(cls, rest);
      Entry e = MAP.get(key);
      if (e == null) {
        // 键里含 ext（可能带网盘 token，会随绑定刷新而变化）→ 给池一个上限，防长期运行积累死实例
        if (MAP.size() > 64) MAP.clear();
        Entry created = new Entry();
        Entry prev = MAP.putIfAbsent(key, created);
        e = prev != null ? prev : created;
      }
      synchronized (e) {
        if (!e.free.isEmpty()) return e.free.pollLast();
        if (e.made < MAX) {
          e.made++;
          return newSpider(env, cls, rest);
        }
      }
      return newSpider(env, cls, rest); // 池内都在忙 → 临时实例（不进池）
    }

    static void release(String cls, String[] rest, Object sp, boolean broken) {
      Entry e = MAP.get(keyOf(cls, rest));
      if (e == null) return;
      synchronized (e) {
        if (broken) {
          e.made = Math.max(0, e.made - 1); // 丢弃并允许下次重建
          return;
        }
        if (e.free.size() < MAX) e.free.addLast(sp);
      }
    }
  }

  /**
   * 新建蜘蛛实例（类加载 + new + init(Context,ext) + initApi）——**一次性路径与实例池共用**。
   * 顺序契约：宿主上下文（setupEnv）必须早于本方法。
   */
  private static Object newSpider(Env env, String cls, String[] rest) throws Exception {
    Class<?> c = Class.forName(cls, true, env.cl);
    Object sp = c.getDeclaredConstructor().newInstance();

    // init(Context, ext)
    try {
      c.getMethod("init", android.content.Context.class, String.class)
          .invoke(sp, env.app, rest.length > 0 ? rest[0] : "");
    } catch (NoSuchMethodException e) {
      try { c.getMethod("init", android.content.Context.class).invoke(sp, env.app); }
      catch (NoSuchMethodException ig) { }
    }

    // initApi(SpiderApi)
    try {
      Class<?> apiCls = Class.forName("com.github.catvod.crawler.SpiderApi", true, env.cl);
      Object api = apiCls.getDeclaredConstructor().newInstance();
      c.getMethod("initApi", apiCls).invoke(sp, api);
    } catch (ClassNotFoundException ig) {
    } catch (NoSuchMethodException ig) {
    } catch (Throwable ig) {
      System.err.println("[SpiderRunner.initApi] " + ig);
    }
    return sp;
  }

  private static Throwable unwrap(Throwable t) {
    Throwable c = t;
    while (c.getCause() != null) c = c.getCause();
    return c;
  }

  /** 运行环境（classloader + Application 单例 + 初始化后的 Init 钩子状态）。 */
  private static class Env {
    final URLClassLoader cl;
    final android.app.Application app;
    Env(URLClassLoader cl, android.app.Application app) { this.cl = cl; this.app = app; }
  }

  /**
   * 一次性环境初始化（classloader + 宿主上下文 + Init/InitOrigin/yq 开关）。
   * ★ 顺序契约：宿主上下文必须早于「加载/实例化蜘蛛类」——蜘蛛构造函数里
   *   就可能用到宿主 Context（Guard 系 BaseSpiderGuard.<init>() → Init.context()）。
   */
  private static Env setupEnv(String[] jars) throws Exception {
    // BouncyCastle provider（AES/CBC/PKCS7Padding，ft y 蜘蛛依赖）
    try {
      java.security.Security.addProvider(new org.bouncycastle.jce.provider.BouncyCastleProvider());
    } catch (Throwable ig) {
      System.err.println("[SpiderRunner] BouncyCastle provider unavailable: " + ig);
    }

    List<URL> urls = new ArrayList<URL>();
    for (String j : jars) urls.add(new File(j).toURI().toURL());
    URLClassLoader cl = new URLClassLoader(urls.toArray(new URL[0]), SpiderRunner.class.getClassLoader());

    // 沙箱数据根（防蜘蛛清理缓存目录）
    try {
      String base = System.getProperty("tvbox.spiderCacheDir");
      if (base != null && base.trim().length() > 0) {
        android.content.Context.setBaseDir(new File(base.trim()));
      }
    } catch (Throwable ig) { }

    // Application 单例（ActivityThread.currentApplication() 反查宿主）
    android.app.Application app = new android.app.Application();
    try { android.app.ActivityThread.setCurrentApplication(app); } catch (Throwable ig) { }

    // Init 钩子（须在加载蜘蛛类之前）
    try {
      Class<?> ic = Class.forName("com.github.catvod.spider.Init", true, cl);
      try { ic.getMethod("init", android.content.Context.class).invoke(null, app); }
      catch (Throwable ig) { System.err.println("[Init] " + ig); }
    } catch (ClassNotFoundException ig) { }
    try {
      Class<?> ic = Class.forName("com.github.catvod.spider.Init", true, cl);
      Object ctx = ic.getMethod("context").invoke(null);
      if (ctx == null) System.err.println("[SpiderRunner] 警告: Init.context() 为 null —— Init.init(Context) 未生效");
    } catch (Throwable ig) { /* 老版本无 context() 正常 */ }

    // InitOrigin 单例（ft y 真实实现宿主上下文）
    try {
      Class<?> ic = Class.forName("com.github.catvod.spider.InitOrigin", true, cl);
      try { ic.getMethod("init", android.content.Context.class).invoke(null, app); }
      catch (NoSuchMethodException ig) { }
      catch (Throwable ig) { System.err.println("[InitOrigin.init] " + ig); }
    } catch (ClassNotFoundException ig) { }

    // fty 壳 Rc 加密分支开关：merge.cn.yq 默认推翻为 true（HideUtils 占位）
    try {
      Class<?> cnCls = Class.forName("com.github.catvod.spider.merge.cn", true, cl);
      try {
        java.lang.reflect.Field yqF = cnCls.getField("yq");
        if (yqF.getType() == boolean.class) yqF.setBoolean(null, true);
      } catch (Throwable ig) { }
    } catch (ClassNotFoundException ig) { }

    return new Env(cl, app);
  }

  /**
   * 单次请求分发（一次性路径）：new 蜘蛛实例 → init → initApi → 调用方法。
   * 常驻路径走 SpiderPool（实例复用，见 serve）。
   * @param reason 失败原因容器（一次性路径传 null；serve 的失败由信封承载）
   */
  private static String dispatch(Env env, String cls, String method, String[] rest, StringBuilder reason) throws Exception {
    Object sp = newSpider(env, cls, rest);
    String result = dispatchMethod(sp, method, rest);
    return result == null ? "" : result;
  }

  /** 方法分发（一次性/常驻共用）。rest[0]=ext(init 已消费)，real args 从 rest[1:] 取值。 */
  private static String dispatchMethod(Object sp, String method, String[] rest) throws Exception {
    String[] r = rest.length > 0 ? Arrays.copyOfRange(rest, 1, rest.length) : new String[0];
    if ("homeContent".equals(method)) {
      return (String) sp.getClass().getMethod("homeContent", boolean.class).invoke(sp, true);
    }
    if ("homeVideoContent".equals(method)) {
      return (String) sp.getClass().getMethod("homeVideoContent").invoke(sp);
    }
    if ("categoryContent".equals(method)) {
      HashMap<String, String> extend = new HashMap<String, String>();
      if (r.length > 2 && !r[2].isEmpty()) {
        for (String kv : r[2].split("&")) {
          int eq = kv.indexOf('=');
          if (eq > 0) {
            String k = kv.substring(0, eq);
            String v = kv.substring(eq + 1);
            try { k = java.net.URLDecoder.decode(k, "UTF-8"); } catch (Throwable ig) { }
            try { v = java.net.URLDecoder.decode(v, "UTF-8"); } catch (Throwable ig) { }
            extend.put(k, v);
          }
        }
      }
      return (String) sp.getClass().getMethod("categoryContent", String.class, String.class, boolean.class, HashMap.class)
          .invoke(sp, r.length > 0 ? r[0] : "", r.length > 1 ? r[1] : "1", true, extend);
    }
    if ("detailContent".equals(method)) {
      return (String) sp.getClass().getMethod("detailContent", List.class)
          .invoke(sp, Arrays.asList((r.length > 0 ? r[0] : "").split(",")));
    }
    if ("searchContent".equals(method)) {
      String wd = r.length > 0 ? r[0] : "";
      try {
        return (String) sp.getClass().getMethod("searchContent", String.class, boolean.class, String.class)
            .invoke(sp, wd, false, r.length > 1 ? r[1] : "1");
      } catch (NoSuchMethodException e) {
        return (String) sp.getClass().getMethod("searchContent", String.class, boolean.class).invoke(sp, wd, false);
      }
    }
    if ("playerContent".equals(method)) {
      List<String> vips = new ArrayList<String>();
      if (r.length > 2 && r[2] != null && !r[2].isEmpty()) {
        for (String v : r[2].split(",")) if (!v.trim().isEmpty()) vips.add(v.trim());
      }
      return (String) sp.getClass().getMethod("playerContent", String.class, String.class, List.class)
          .invoke(sp, r.length > 0 ? r[0] : "", r.length > 1 ? r[1] : "", vips);
    }
    if ("liveContent".equals(method)) {
      return (String) sp.getClass().getMethod("liveContent", String.class).invoke(sp, r.length > 0 ? r[0] : "");
    }
    if ("proxy".equals(method)) {
      HashMap<String, String> params = new HashMap<String, String>();
      if (r.length > 0 && !r[0].isEmpty()) {
        try {
          Object ret0 = new com.google.gson.Gson().fromJson(r[0], new com.google.gson.reflect.TypeToken<java.util.Map<String, String>>() {}.getType());
          if (ret0 instanceof java.util.Map) params.putAll((java.util.Map<String, String>) ret0);
        } catch (Throwable ig) { }
      }
      Object ret = sp.getClass().getMethod("proxy", java.util.Map.class).invoke(sp, params);
      if (ret instanceof Object[]) {
        Object[] arr = (Object[]) ret;
        for (int k = 0; k < arr.length; k++) {
          if (arr[k] instanceof java.io.InputStream) {
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            try {
              byte[] buf = new byte[8192];
              int n;
              java.io.InputStream is = (java.io.InputStream) arr[k];
              while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
            } catch (Throwable ig) { }
            arr[k] = new String(bos.toByteArray(), java.nio.charset.StandardCharsets.UTF_8);
          }
        }
        ret = arr;
      }
      return ret == null ? "" : new com.google.gson.Gson().toJson(ret);
    }
    throw new IllegalArgumentException("unknown method: " + method);
  }
}