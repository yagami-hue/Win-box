import java.io.File;
import java.lang.reflect.Method;
import java.net.URL;
import java.net.URLClassLoader;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;

/**
 * 桌面版 Spider 运行器 —— 等效 DexClassLoader 的宿主侧。
 * 用法: SpiderRunner <spiderJar>[;<jar2>...] <className> <method> [args...]
 * 结果 JSON 打到 stdout；错误/日志走 stderr。
 */
public class SpiderRunner {

  public static void main(String[] args) {
    int code = 0;
    try {
      if (args.length < 3) throw new IllegalArgumentException("usage: SpiderRunner <jars;...> <className> <method> [args...]");
      String[] jars = args[0].split(";");

      // ★ 2026-09-16 修复：注册 BouncyCastle provider，解决 AES/CBC/PKCS7Padding
      //   不可用问题（Android 支持 PKCS7Padding，JDK SunJCE 不支持）。
      //   吃瓜(LiveGz)/海绵(Hmys) 等 fty 蜘蛛依赖该算法做响应解密/签名。
      //   bcprov jar 必须位于运行时 classpath（resources/jvm/libs/ 下）。
      try {
        java.security.Security.addProvider(new org.bouncycastle.jce.provider.BouncyCastleProvider());
      } catch (Throwable ig) {
        System.err.println("[SpiderRunner] BouncyCastle provider unavailable: " + ig);
      }

      List<URL> urls = new ArrayList<URL>();
      for (String j : jars) urls.add(new File(j).toURI().toURL());
      URLClassLoader cl = new URLClassLoader(urls.toArray(new URL[0]), SpiderRunner.class.getClassLoader());
      String cls = args[1];
      String method = args[2];
      String[] rest = args.length > 3 ? Arrays.copyOfRange(args, 3, args.length) : new String[0];

      // ★ 把蜘蛛可见的数据根收进宿主指定的沙箱目录
      //   背景：`Context.getCacheDir()` 默认取 `java.io.tmpdir/tvbox-win/cache`。
      //   部分蜘蛛会在初始化时**清理**这个目录（实测 DexNative.<clinit> 就调用
      //   `Init.deleteFilesWithFeature(getCacheDir(), ".wexfnw")` 删除其中的文件）。
      //   一旦 `java.io.tmpdir` 恰好等于应用数据目录，`getCacheDir()` 就会落在
      //   <userData>/cache 上 —— 而我们的**转换产物**也在 <userData>/cache/spider/
      //   converted 下，蜘蛛的清理就可能把 jar 缓存删掉，导致所有源集体
      //   `ClassNotFoundException`（实测过一次：95 个源同时失���）。
      //   这里由宿主显式指定沙箱，且放在 converted 的**同级兄弟目录**，
      //   蜘蛛无论如何递归清理都出不了这个子目录。
      try {
        String base = System.getProperty("tvbox.spiderCacheDir");
        if (base != null && base.trim().length() > 0) {
          android.content.Context.setBaseDir(new File(base.trim()));
        }
      } catch (Throwable ig) {
        // 拿不到就用默认值，不影响主流程
      }

      // ==================================================================
      // ★ 顺序契约：宿主上下文必须早于「加载/实例化蜘蛛类」，勿调换 ★
      //
      //   蜘蛛的**构造函数**里就可能用到宿主 Context。典型是 "Guard" 系蜘蛛
      //   （同一批 jar 里上百个类：NewDouBanGuard / BiliGuard / AiNewXxxGuard /
      //   MusicAiQingTingGuard / PanConfigGuard ...）：
      //
      //       BaseSpiderGuard.<init>() → Init.getSpider() → DexNative.<clinit>()
      //           → Init.context().getCacheDir()        ← 此处 NPE
      //
      //   历史 bug 的顺序是「先 newInstance() 再 Init.init()」：构造蜘蛛时
      //   Init 的静态字段还是 null，于是抛
      //       NullPointerException: Cannot invoke "android.content.Context.getCacheDir()"
      //       because the return value of "com.github.catvod.spider.Init.context()" is null
      //   而 `DexNative` 一旦类初始化失败就被 JVM 标记为 erroneous，该 jar 里
      //   **所有**蜘蛛全部不可用（实测一套配置 97 个源同一报错）。
      // ==================================================================

      // 1) Application 单例 —— 部分蜘蛛走 ActivityThread.currentApplication() 反查宿主。
      //    必须与后面 init(Context) 传给蜘蛛的是同一个对象，否则引用比较会不相等。
      android.app.Application app = new android.app.Application();
      try { android.app.ActivityThread.setCurrentApplication(app); } catch (Throwable ig) { }

      // 2) Init 钩子 —— 既做全局初始化，也是 Init.context() 的数据源。
      //    必须在加载蜘蛛类之前执行（见上方顺序契约）。
      try {
        Class<?> ic = Class.forName("com.github.catvod.spider.Init", true, cl);
        try { ic.getMethod("init", android.content.Context.class).invoke(null, app); }
        catch (Throwable ig) { System.err.println("[Init] " + ig); }
      } catch (ClassNotFoundException ig) { }

      // 3) 预检：Init 存在则 context() 必须非 null，否则后面必然在蜘蛛内部 NPE。
      //    把"深藏在第三方字节码里的空指针"提前变成一句可行动的话。
      try {
        Class<?> ic = Class.forName("com.github.catvod.spider.Init", true, cl);
        Object ctx = ic.getMethod("context").invoke(null);
        if (ctx == null) {
          System.err.println("[SpiderRunner] 警告: Init.context() 为 null —— "
              + "Init.init(Context) 未生效，蜘蛛初始化可能失败");
        }
      } catch (ClassNotFoundException ig) {
        // 蜘蛛 jar 不带 Init（老版本），正常
      } catch (NoSuchMethodException ig) {
        // Init 没有 context()（更老的版本），正常
      } catch (Throwable ig) {
        System.err.println("[SpiderRunner.contextCheck] " + ig);
      }

      // 2.5) InitOrigin 单例初始化 —— fty/Coinsheel 等真实实现用 InitOrigin.context()
      //     作宿主上下文（getFilesDir/getSharedPreferences）。不注入则迁移后的真实蜘蛛
      //     在 <clinit>/merge.Z 初始化时 NPE（context()==null）。命中则塞宿主 Application。
      try {
        Class<?> ic = Class.forName("com.github.catvod.spider.InitOrigin", true, cl);
        try { ic.getMethod("init", android.content.Context.class).invoke(null, app); }
        catch (NoSuchMethodException ig) { }
        catch (Throwable ig) { System.err.println("[InitOrigin.init] " + ig); }
      } catch (ClassNotFoundException ig) { }

      // 2.6) ★ fty 壳 jar 的 Rc 加密分支开关（merge.cn.yq）—— 默认强制走 HideUtils 占位分支 ★
      //     yq=false（JVM 默认）时，Rc.B/Gc/KJ/n 走 InitOrigin.i 反射分支；桌面版没有饭太硬
      //     主程序注入的 InitOrigin.i（且抢收 jar 的 short[] 短于解码所需索引）→ 必然
      //     NPE/ArrayIndexOutOfBounds → catch 后返回空串 → 依赖 Rc 的 fty 源整体不可用。
      //     yq=true 时改走 HideUtils 占位分支（decrypt/encrypt 返回原串，不抛错）：
      //     - 内部配置为**明文**（经 short[] 解码器解出，不经 Rc）的蜘蛛 → 完全恢复正常
      //       （实测 YCyz/NewCz/Nmyswv/Dm84/Music/Doubao/Kanqiu/Tingshu275/FirstAid/JPJ/Auete 等
      //       12 个 fty 源在 yq=false 下首页全空，yq=true 下全部返回真实内容）；
      //     - 依赖 Rc 真实加密签名/解密 blob ext 的源（转存链路、加密 ext 源）→ 占位无法
      //       还原真实值，仍不可用（与 yq=false 等价，不更差）；
      //     - 明文 ext 源（立播/新6V）不依赖 Rc → 行为完全不变（已回归验证）。
      //     非 fty jar 没有 merge.cn 类，本段无副作用（ClassNotFoundException 即跳过）。
      //     兼容旧开关 -Dtvbox.shellShim.forceHideUtils（其值为 false 时仍强制启用）。
      try {
        Class<?> cnCls = Class.forName("com.github.catvod.spider.merge.cn", true, cl);
        try {
          java.lang.reflect.Field yqF = cnCls.getField("yq");
          if (yqF.getType() == boolean.class) yqF.setBoolean(null, true);
        } catch (Throwable ig) { /* yq 字段形态不同则跳过 */ }
      } catch (ClassNotFoundException ig) { /* 非 fty jar */ }

      // 4) 蜘蛛实例（必须在上面的上下文就绪之后 —— 见顺序契约）
      Class<?> c = Class.forName(cls, true, cl);
      Object sp = c.getDeclaredConstructor().newInstance();

      // 5) init(Context, ext)
      try {
        Method m = c.getMethod("init", android.content.Context.class, String.class);
        m.invoke(sp, app, rest.length > 0 ? rest[0] : "");
      } catch (NoSuchMethodException e) {
        try { c.getMethod("init", android.content.Context.class).invoke(sp, app); }
        catch (NoSuchMethodException ig) { }
      }

      // 6) initApi(SpiderApi) —— 宿主能力注入（等效安卓原版 App/Activity 传递）
      //   ★ 这是与安卓原版对齐的关键一步：新版蜘蛛（XBPQ 等）覆写了 initApi 并
      //     把 api 引用存进字段，之后 homeContent 里大量调用 api.log(...)。若宿主
      //     不注入，蜘蛛字段恒为 null → 内部 NPE（表现为"蜘蛛返回空结果"，
      //     日志里完全看不出跟宿主有关）。
      //   签名不匹配时静默跳过：老蜘蛛没有这个方法，属正常情况。
      try {
        Class<?> apiCls = Class.forName("com.github.catvod.crawler.SpiderApi", true, cl);
        Object api = apiCls.getDeclaredConstructor().newInstance();
        c.getMethod("initApi", apiCls).invoke(sp, api);
      } catch (ClassNotFoundException ig) {
        // 蜘蛛 jar 未引用 SpiderApi（老版本），正常。
      } catch (NoSuchMethodException ig) {
        // 蜘蛛未覆写 initApi（老版本），正常。
      } catch (Throwable ig) {
        System.err.println("[SpiderRunner.initApi] " + ig);
      }

      // 7) 分发调用
      String result;
      String[] r = rest.length > 0 ? Arrays.copyOfRange(rest, 1, rest.length) : new String[0];
      if ("homeContent".equals(method)) {
        result = (String) c.getMethod("homeContent", boolean.class).invoke(sp, true);
      } else if ("homeVideoContent".equals(method)) {
        result = (String) c.getMethod("homeVideoContent").invoke(sp);
      } else if ("categoryContent".equals(method)) {
        HashMap<String, String> extend = new HashMap<String, String>();
        if (r.length > 2 && !r[2].isEmpty()) {
          for (String kv : r[2].split("&")) {
            int eq = kv.indexOf('=');
            if (eq > 0) {
              String k = kv.substring(0, eq);
              String v = kv.substring(eq + 1);
              // ★ 桥层对 extend 的 key/value 做了 encodeURIComponent；这里还原成原始值
              //   （筛选值含 `&`/`=`/中文 时不还原会把 HashMap 拆错）。
              try {
                k = java.net.URLDecoder.decode(k, "UTF-8");
              } catch (Throwable ig) { }
              try {
                v = java.net.URLDecoder.decode(v, "UTF-8");
              } catch (Throwable ig) { }
              extend.put(k, v);
            }
          }
        }
        result = (String) c.getMethod("categoryContent", String.class, String.class, boolean.class, HashMap.class)
            .invoke(sp, r.length > 0 ? r[0] : "", r.length > 1 ? r[1] : "1", true, extend);
      } else if ("detailContent".equals(method)) {
        result = (String) c.getMethod("detailContent", List.class).invoke(sp, Arrays.asList((r.length > 0 ? r[0] : "").split(",")));
      } else if ("searchContent".equals(method)) {
        String wd = r.length > 0 ? r[0] : "";
        try {
          result = (String) c.getMethod("searchContent", String.class, boolean.class, String.class).invoke(sp, wd, false, r.length > 1 ? r[1] : "1");
        } catch (NoSuchMethodException e) {
          result = (String) c.getMethod("searchContent", String.class, boolean.class).invoke(sp, wd, false);
        }
      } else if ("playerContent".equals(method)) {
        // A2：vipFlags 由桥层以逗号串传入（r[2]），恢复成 List 交给蜘蛛（缺省空列表）
        List<String> vips = new ArrayList<String>();
        if (r.length > 2 && r[2] != null && !r[2].isEmpty()) {
          for (String v : r[2].split(",")) {
            if (!v.trim().isEmpty()) vips.add(v.trim());
          }
        }
        result = (String) c.getMethod("playerContent", String.class, String.class, List.class)
            .invoke(sp, r.length > 0 ? r[0] : "", r.length > 1 ? r[1] : "", vips);
      } else if ("liveContent".equals(method)) {
        result = (String) c.getMethod("liveContent", String.class).invoke(sp, r.length > 0 ? r[0] : "");
      } else if ("proxy".equals(method)) {
        // 源内绑定/代理入口：proxy(Map<String,String>) 返回 Object[]（二维码/输入框/302 data），
        // 用 Gson 序列化成 JSON 打 stdout；param 经 JSON 解析构造。基类已声明 proxy → 未覆写安全返回 null。
        HashMap<String, String> params = new HashMap<String, String>();
        if (r.length > 0 && !r[0].isEmpty()) {
          try {
            java.lang.reflect.Type t = new com.google.gson.reflect.TypeToken<java.util.Map<String, String>>() {}.getType();
            java.util.Map<String, String> m = new com.google.gson.Gson().fromJson(r[0], t);
            if (m != null) params.putAll(m);
          } catch (Throwable ig) { /* 参数非法则按空 map 调用，交由蜘蛛兜底 */ }
        }
        Object ret = c.getMethod("proxy", java.util.Map.class).invoke(sp, params);
        // ★ Object[] 里可能含 java.io.InputStream（本地代理页面/二维码内容/302 data）——
        //   Gson 无法序列化流。读成 UTF-8 字符串（空流则空串），保证上层拿到可读 JSON。
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
              } catch (Throwable ig) { /* 流读失败按空处理 */ }
              arr[k] = new String(bos.toByteArray(), java.nio.charset.StandardCharsets.UTF_8);
            }
          }
          ret = arr;
        }
        result = ret == null ? "" : new com.google.gson.Gson().toJson(ret);
      } else {
        throw new IllegalArgumentException("unknown method: " + method);
      }
      System.out.println(result == null ? "" : result);
    } catch (Throwable t) {
      Throwable cause = t;
      while (cause.getCause() != null) cause = cause.getCause();
      System.err.println("[SpiderRunner.ERROR] " + cause.getClass().getName() + ": " + cause.getMessage());
      StackTraceElement[] st = cause.getStackTrace();
      for (int i = 0; i < Math.min(6, st.length); i++) System.err.println("    at " + st[i]);
      code = 1;
    }
    System.exit(code);
  }
}
