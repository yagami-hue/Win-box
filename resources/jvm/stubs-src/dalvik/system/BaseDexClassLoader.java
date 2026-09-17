package dalvik.system;

import java.io.File;
import java.net.URL;
import java.net.URLClassLoader;
import java.util.ArrayList;
import java.util.List;

/**
 * BaseDexClassLoader stub —— 安卓动态 dex 加载器的基类（等效 DexClassLoader 的血统）。
 *
 * <p><b>为什么需要这一族类：</b>不少「加固 / 壳」型蜘蛛 jar（典型如含
 * {@code com.github.catvod.spider.DexNative} 的那批 {@code *Guard} 类）走的是
 * <b>安卓原生加载链</b>：
 * <pre>
 *   Init.init(Context) → DexNative.getLoader(ctx)      // native 方法
 *                          └─ 解密 assets/xxx.guard、new DexClassLoader(...)
 *   BaseSpiderGuard.&lt;init&gt;() → Init.getSpider() → DexNative.proxyInvoke(...)
 * </pre>
 * 只要 {@code dalvik.system.DexClassLoader} 不存在，{@code Init.init} 就会抛
 * {@code NoClassDefFoundError}，导致 {@code Init.context()} 恒为 null，
 * 蜘蛛构造函数里读 {@code Init.context().getCacheDir()} 直接空指针 ——
 * 报错信息是
 * {@code Cannot invoke "android.content.Context.getCacheDir()" because the return value of
 * "com.github.catvod.spider.Init.context()" is null}，
 * 与真实原因（缺 dalvik 类 / 依赖安卓原生库）看不出任何关联。
 *
 * <p><b>本 stub 的能力边界（务必如实告知用户）：</b>
 * <ul>
 *   <li><b>能</b>：让这一类名解析成功，把「类找不到」的硬崩溃降级成可解释的失败；
 *       对路径里是普通 <b>jar / zip / apk</b>（内含 .class 或可被 JVM 直接读的归档）
 *       的情况，用 {@link URLClassLoader} 真正加载。</li>
 *   <li><b>不能</b>：加载裸 {@code .dex}（JVM 无法直接执行 dalvik 字节码）；
 *       更不能替代安卓原生库（{@code .so} 是 ARM/AArch64 ELF，与 Windows JVM 不同 ABI）。
 *       这类源在桌面端<b>架构上无法运行</b>，不是移植缺陷。</li>
 * </ul>
 */
public class BaseDexClassLoader extends ClassLoader {

    private final String dexPath;
    private final File optimizedDirectory;
    private final String librarySearchPath;

    /** 真正能用的部分：对 jar/zip/apk 用 URLClassLoader 代理。 */
    private URLClassLoader delegate;
    /** 无法处理的条目（裸 .dex 等），首次 loadClass 时用于给出准确报错。 */
    private final List<String> unsupported = new ArrayList<String>();

    public BaseDexClassLoader(String dexPath, File optimizedDirectory,
                              String librarySearchPath, ClassLoader parent) {
        super(parent);
        this.dexPath = dexPath == null ? "" : dexPath;
        this.optimizedDirectory = optimizedDirectory;
        this.librarySearchPath = librarySearchPath;
        this.delegate = buildDelegate(this.dexPath, parent);
    }

    public BaseDexClassLoader(String dexPath, String optimizedDirectory,
                              String librarySearchPath, ClassLoader parent) {
        this(dexPath, optimizedDirectory == null ? null : new File(optimizedDirectory),
                librarySearchPath, parent);
    }

    /**
     * 把路径里「JVM 能直接读的归档」抽出来交给 URLClassLoader。
     * 裸 .dex 会被记入 {@link #unsupported}（桌面 JVM 无法执行 dalvik 字节码）。
     */
    private URLClassLoader buildDelegate(String path, ClassLoader parent) {
        if (path == null || path.isEmpty()) return null;
        List<URL> urls = new ArrayList<URL>();
        for (String p : path.split(File.pathSeparator)) {
            String s = p == null ? "" : p.trim();
            if (s.isEmpty()) continue;
            String lower = s.toLowerCase();
            boolean loadable = lower.endsWith(".jar") || lower.endsWith(".zip") || lower.endsWith(".apk");
            if (!loadable) {
                unsupported.add(s);
                continue;
            }
            try {
                urls.add(new File(s).toURI().toURL());
            } catch (Throwable th) {
                unsupported.add(s);
            }
        }
        if (urls.isEmpty()) return null;
        try {
            return new URLClassLoader(urls.toArray(new URL[0]), parent);
        } catch (Throwable th) {
            return null;
        }
    }

    @Override
    protected Class<?> findClass(String name) throws ClassNotFoundException {
        if (delegate != null) {
            try {
                return delegate.loadClass(name);
            } catch (ClassNotFoundException ignored) {
                // 落到下面的统一报错
            }
        }
        if (!unsupported.isEmpty()) {
            throw new ClassNotFoundException(name
                    + "（桌面版无法加载 dex/so：该路径含 " + unsupported
                    + "；安卓原生库与 dalvik 字节码在 Windows JVM 上无法执行）");
        }
        throw new ClassNotFoundException(name);
    }

    public String getDexPath() {
        return dexPath;
    }

    /** 供诊断：返回本加载器无法处理的路径条目。 */
    public List<String> getUnsupportedPaths() {
        return new ArrayList<String>(unsupported);
    }

    /** 供诊断：是否具备真正可用的加载能力。 */
    public boolean isFunctional() {
        return delegate != null;
    }

    /** 安卓 API 上有这个方法，加固代码常调用它做大包路径判断。 */
    public String findLibrary(String name) {
        if (librarySearchPath == null || name == null) return null;
        for (String dir : librarySearchPath.split(File.pathSeparator)) {
            if (dir == null || dir.trim().isEmpty()) continue;
            File f = new File(dir.trim(), System.mapLibraryName(name));
            if (f.exists()) return f.getAbsolutePath();
        }
        return null;
    }

    @Override
    public String toString() {
        return getClass().getName() + "[dexPath=" + dexPath
                + ", functional=" + isFunctional() + "]";
    }
}
