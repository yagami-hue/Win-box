package com.github.catvod.spider;

import dalvik.system.DexClassLoader;

import java.io.File;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.net.URL;
import java.net.URLClassLoader;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * DexNative 的**纯 Java 影子类**（方案 A）。
 *
 * 用法：把它编成 `shell-shim.jar`，放在 SpiderRunner 的 classpath **最前面**，
 * 靠类加载顺序**覆盖**加固壳 jar 里那个 native 版本的 `DexNative`。
 * 于是壳的这座桥：
 *
 * ```
 * Init.init(ctx)      → DexNative.getLoader(ctx)            → Init 的 loader 字段
 * BaseSpiderGuard.<init> → Init.getSpider(name)
 *                          → DexNative.getSpider(loader,name) → 真实 Spider 实例
 * 之后所有 homeContent/categoryContent/... 都是纯 Java 委托
 * ```
 *
 * 就在**没有任何 native 代码**的情况下整条打通 —— 不再需要 `System.load(ARM.so)`。
 *
 * ── 为什么这个方案成立（都是实测结论，不是推测）──
 * 1. `BaseSpiderGuard` 是**纯委托**：反编译显示其全部方法体只有
 *    "取私有字段 + invokevirtual"（12 条 invokevirtual、0 条 ldc/getstatic/new），
 *    业务逻辑一行都不在里面。所以只要把"真实 Spider"给它，壳就活了。
 * 2. 壳里每个具体源（`NewDouBanGuard` 等）也都是空壳：
 *    `class XxxGuard extends BaseSpiderGuard { public XxxGuard(); }` —— 只有构造函数。
 * 3. 因此**唯一缺的东西**就是"真实 Spider 从哪来"。壳原本靠 native 解密
 *    `assets/*.guard` 再用 DexClassLoader 加载；本影子类改为**用给定的 jar / 目录**加载。
 *
 * ── ★ 本方案的前提（务必先确认）──
 * 需要一份**含真实 Spider 实现**的 jar（或 classes 目录）作为 `shimClasses`。
 * 对 `wexguard/shinidie` 这类**把代码加密**的壳，这份东西**不在 jar 里**：
 * 实测 `assets/wexshinidie.guard`（930,055 B）零明文（`com/github/catvod`、
 * `Lcom/`、`catvod`、`dex\n035`、`PK\x03\x04` 全部搜不到），也不是 zlib/gzip
 * （三种 wbits 全部 `incorrect header check`）。**它只能由 ARM native 解密。**
 * 所以本影子类的正确用法是：
 *   · 对**明文实现**的加固 jar（壳只是包装、真实类在 jar 内或随包提供）→ 直接可用；
 *   · 对**代码加密**的壳 → 先用别的手段（ARM 环境一次性取证 / 逆向）拿到解密后的 jar，
 *     再喂给本类。**拿到之后，剩下的全部工作就是本类这点代码。**
 *
 * 配置来源（按优先级）：
 *  1. 系统属性 `tvbox.shellShimClasses`（分号分隔的 jar/目录）
 *  2. 环境变量 `TVBOX_SHELL_SHIM_CLASSES`
 */
public class DexNative {

    /** 与壳里的字段同名同义：DexClassLoader */
    private static ClassLoader loader;

    private static final Map<String, Object> CACHE = new ConcurrentHashMap<>();

    /** 正在构造中的类（每个线程一份），用于打断壳的"自我委托"递归 */
    private static final ThreadLocal<java.util.Set<String>> CONSTRUCTING =
            ThreadLocal.withInitial(java.util.HashSet::new);

    /** 日志开关：`-Dtvbox.shellShim.debug=true` */
    private static boolean debug() {
        return "true".equalsIgnoreCase(System.getProperty("tvbox.shellShim.debug", "false"));
    }

    private static void log(String msg) {
        if (debug()) System.err.println("[ShellShim] " + msg);
    }

    /**
     * 壳的 `Init.init(ctx)` 会调它，返回的 loader 被存进 `Init.loader()`，
     * 之后 `getSpider` 再拿它去 `loadClass`。
     */
    public static Object getLoader(Object context) {
        if (loader == null) {
            loader = buildLoader();
            // ★ 真实实现（如 fty）有自己的 Context 单例 InitOrigin，必须用宿主上下文初始化，
            //   否则真实蜘蛛里 InitOrigin.context().getFilesDir()/getSharedPreferences() 会 NPE。
            initOrigin(context);
            forceHideUtils();
            log("getLoader -> " + loader);
        }
        return loader;
    }

    /** 初始化真实实现的 InitOrigin（若有），把宿主 Application 塞进去。 */
    private static void initOrigin(Object context) {
        if (context == null) return;
        try {
            Class<?> io = Class.forName("com.github.catvod.spider.InitOrigin", true, loader);
            io.getMethod("init", android.content.Context.class).invoke(null, context);
            log("InitOrigin.init OK");
        } catch (ClassNotFoundException ignored) {
            // 该壳没有 InitOrigin（其它壳 / 普通 jar），无影响
        } catch (Throwable t) {
            log("InitOrigin.init 失败: " + t);
        }
    }

    /**
     * 桌面侧兜底：真实实现的 Rc 加密（B/Gc/KJ/n）默认走 InitOrigin.i 反射分支，
     * 而 InitOrigin.i 是饭太硬主程序注入的私有类、桌面版无法提供 → 恒 NPE 返回空串。
     * 这里把 merge.cn.yq 置为 true，让 Rc 改走 HideUtils 分支（我们 stub 里的占位实现）。
     *
     * 仅供「验证占位 stub 影响」的实验开关：设 -Dtvbox.shellShim.forceHideUtils=true 才生效。
     * 占位 HideUtils（原串/标准 MD5）未必等价饭太硬私有算法，但至少比 NPE 空串更接近。
     */
    private static void forceHideUtils() {
        if (!"true".equalsIgnoreCase(System.getProperty("tvbox.shellShim.forceHideUtils", "false"))) return;
        try {
            Class<?> cn = Class.forName("com.github.catvod.spider.merge.cn", true, loader);
            java.lang.reflect.Field f = cn.getField("yq");
            f.setBoolean(null, true);
            log("已强制 merge.cn.yq=true（走 HideUtils 分支）");
        } catch (Throwable t) {
            log("强制 cn.yq 失败: " + t);
        }
    }

    /**
     * 壳的 `Init.getSpider(name)` 会调它。
     * name 形如 `com.github.catvod.spider.NewDouBanGuard`。
     *
     * ★ 关键：请求的类名是 **Guard 壳类**，而真实 Spider 在 shim 包里对应同一个类名。
     *   所以这里先试"从 shimClasses 用同名类加载"；
     *   加载不到再退回"实例化传入的那个 name"。
     */
    @SuppressWarnings("unchecked")
    public static Object getSpider(Object loaderObj, String name) {
        if (name == null) return null;
        Object cached = CACHE.get(name);
        if (cached != null) return cached;

        // ★★ 环检测（本方案最容易踩的坑，实测踩到过）★★
        //   壳的委托链会请求**正在构造中**的那个类：
        //       new NewDouBanGuard() → BaseSpiderGuard.<init> → Init.getSpider("NewDouBanGuard")
        //       → 这里 → new NewDouBanGuard() → ... 无限递归 → StackOverflowError
        //   对"壳类本身"必须直接返回 null：壳的字段留 null 是**合法状态**
        //   （真实实现不在 jar 里时才如此；若 shimClasses 提供了同名真实类，
        //     下面那条 Class.forName 会先命中，根本不会走到这里）。
        String dotted = name.replace('/', '.');
        if (CONSTRUCTING.get().contains(dotted)) {
            log("getSpider(" + dotted + ") 命中环检测 → 返回 null（避免自递归）");
            return null;
        }
        ClassLoader l = loaderObj instanceof ClassLoader ? (ClassLoader) loaderObj : null;
        if (l == null) l = loader;
        if (l == null) l = buildLoader();

        // ★ 先按原类名找**真实实现**；找不到再试"剥掉 Guard 后缀"的名字
        //   （对齐 PlayHub 的 buildClassNameCandidates：`XxxGuard` → `Xxx`）。
        //   真实实现存在于 shimClasses 时这一步就命中，桥就是通的；
        //   全都不命中说明 shimClasses 没提供实现（见错因日志）。
        for (String candidate : candidates(dotted)) {
            try {
                Class<?> c = Class.forName(candidate, true, l);
                CONSTRUCTING.get().add(candidate);
                Object spider;
                try {
                    spider = c.getDeclaredConstructor().newInstance();
                } finally {
                    CONSTRUCTING.get().remove(candidate);
                }
                log("getSpider(" + dotted + ") -> " + candidate + " = " + spider);
                CACHE.put(name, spider);
                return spider;
            } catch (Throwable t) {
                log("getSpider 候选 " + candidate + " 未命中: " + t);
            }
        }

        log("getSpider(" + dotted + ") 无真实实现可加载 → 返回 null"
                + "（需要 -Dtvbox.shellShimClasses 指向含真实 Spider 的 jar）");
        return null;
    }

    /** 候选类名：去 Guard 的真实名 → 首字母小写变体 → 原名（回退） */
    private static java.util.List<String> candidates(String dotted) {
        java.util.List<String> out = new java.util.ArrayList<>();
        int dot = dotted.lastIndexOf('.');
        String pkg = dot < 0 ? "" : dotted.substring(0, dot + 1);
        String simple = dot < 0 ? dotted : dotted.substring(dot + 1);
        if (simple.endsWith("Guard")) {
            String stripped = simple.substring(0, simple.length() - "Guard".length());
            if (!stripped.isEmpty()) {
                // ★ 真实实现在解出来的 jar 里常叫 Xxx（不带 Guard），而壳 jar 里只放
                //   XxxGuard 的空壳。父委托会把 XxxGuard 解析到壳 jar → 拿到空壳。
                //   所以把「去 Guard 的真实名」排在前面，优先命中真实实现。
                out.add(pkg + stripped);
                out.add(pkg + Character.toLowerCase(stripped.charAt(0)) + stripped.substring(1));
            }
        }
        out.add(dotted);
        return out;
    }

    /** 壳里 `proxyInvoke` 从未被调用（第八轮实测全文 0 次），这里给出等价的无害实现 */
    public static Object[] proxyInvoke(Map<String, String> params) {
        log("proxyInvoke 被调用（壳通常不会走这里）");
        return new Object[] { null, null };
    }

    /**
     * ★ 弹幕启动（真实实现 DexNative 有 danmuStart()/danmuStart(boolean) 两个重载）。
     *   桌面板不做弹幕，但 fty 系网盘蜘蛛的 playerContent 会调用它（加载播放器弹幕），
     *   影子类缺此方法时会抛 NoSuchMethodError 导致 playerContent 整体失败。
     *   给出空实现即可（弹幕关闭，不影响取播放地址）。
     */
    public static void danmuStart() {
        log("danmuStart() 桌面无弹幕，空实现");
    }

    public static void danmuStart(boolean enable) {
        log("danmuStart(" + enable + ") 桌面无弹幕，空实现");
    }

    // ------------------------------------------------------------------

    private static ClassLoader buildLoader() {
        try {
            String spec = System.getProperty("tvbox.shellShimClasses");
            if (spec == null || spec.isBlank()) spec = System.getenv("TVBOX_SHELL_SHIM_CLASSES");
            java.util.List<URL> urls = new java.util.ArrayList<>();
            StringBuilder paths = new StringBuilder();
            if (spec != null && !spec.isBlank()) {
                for (String p : spec.split(";")) {
                    if (p.isBlank()) continue;
                    urls.add(new File(p.trim()).toURI().toURL());
                    if (paths.length() > 0) paths.append(File.pathSeparator);
                    paths.append(p.trim());
                }
            }
            log("shellShimClasses = " + urls);
            // ★ 壳的 `Init.init` 里是 `(DexClassLoader) DexNative.getLoader(ctx)`，
            //   返回**普通 URLClassLoader 会 ClassCastException** —— 必须返回
            //   `dalvik.system.DexClassLoader`（我们 stub 里那个 extends URLClassLoader 的类）。
            URL[] arr = urls.toArray(new URL[0]);
            ClassLoader parent = DexNative.class.getClassLoader();
            try {
                Class<?> dcl = Class.forName("dalvik.system.DexClassLoader", true, parent);
                return (ClassLoader) dcl.getConstructor(String.class, String.class, String.class, ClassLoader.class)
                        .newInstance(paths.toString(), null, null, parent);
            } catch (Throwable t) {
                log("构造 DexClassLoader 失败，回退 URLClassLoader: " + t);
                return new URLClassLoader(arr, parent);
            }
        } catch (Throwable t) {
            log("构建 loader 失败: " + t);
            return new URLClassLoader(new URL[0], DexNative.class.getClassLoader());
        }
    }

    /** 便于诊断：把一个类从 shim loader 里找出来（不实例化） */
    public static Class<?> peek(String name) throws ClassNotFoundException {
        return Class.forName(name, false, loader != null ? loader : buildLoader());
    }

    static {
        log("DexNative 影子类已加载（纯 Java，无 native）");
    }

    // 让 javac 不报未使用告警用的引用（DexClassLoader 是壳的签名类型，保留说明用）
    static {
        if (false) {
            DexClassLoader ignore = null;
            Constructor<?> c = null;
            Method m = null;
        }
    }
}
