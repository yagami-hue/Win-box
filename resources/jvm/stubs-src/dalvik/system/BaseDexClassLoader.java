package dalvik.system;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.net.URLClassLoader;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

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
 *
 * <p><b>★★ 2026-09-27「壳通解」：裸 .dex 现在能真正加载了（勿回退）★★</b>
 * <p>壳把 {@code assets/<X>.guard} 交给随包的 ARM {@code .so} 解密，得到明文 dex
 * （在 x64 上这一步由 unidbg 原生桥代跑，见 resources/jvm/native-bridge/），
 * 随后走 {@code new DexClassLoader(dexPath, …)}。
 * 本类对**裸 .dex**（以及「只含 classes.dex 的归档」）就地做一次
 * <b>运行时 dex2jar</b>（与宿主 JarSpiderBridge 同一条 d2j 链，按 dex 内容 md5 缓存），
 * 再用 {@link URLClassLoader} 加载 —— 于是任何「native 解密自己 dex」的壳都不再需要
 * 逐壳真机取证。
 * <p><b>★ 2026-09-27：转换「代价只付一次」</b> —— 产物写 `&lt;md5&gt;.part.jar` 后原子改名，
 * 输出落日志文件（不走管道）；本 JVM 被宿主 kill 后，子进程写完的 part 会在下次进源时
 * 直接**收编**（见 {@link #dexToJar} 的注释），不会再让用户对着「首次加载」等第二遍。
 *
 * <p><b>★★ 2026-09-27（新订阅 96 源全空）「产物收尾」两步（勿删）★★</b>
 * 实测解密产物是 **zip**（`classes.dex` + `assets/libwex_v7.so` + `assets/libwex_v8.so`），
 * 而 dex2jar 只产出 .class ⇒ 载荷类 `<clinit>` 里
 * {@code InitOrigin.classLoader().getResourceAsStream("assets/libwex_v8.so")} 恒为 null（NPE），
 * 且产物里存在 dex2jar 的「NEW 抽象类」误译（运行时 InstantiationError）。故转换后必须：
 * <ol>
 *   <li>{@link #copyArchiveResources}：把源归档的非 class 条目补进产物（assets 等）；</li>
 *   <li>{@link #repairNewSites}：反射调原生桥的 {@code com.winbox.nativebridge.DexJarRepair}
 *       修 NEW 抽象类（桥缺失则跳过）。</li>
 * </ol>
 * 两者一起用标记文件 `&lt;产物&gt;.fix.ok` 保证只做一次；产物名带版本号
 * {@link #PRODUCT_REV}（旧产物自动失效、重转一次）。
 *
 * <p>依赖三个系统属性（由宿主 {@code JarSpiderBridge.jvmPrefix} 注入）：
 * <ul>
 *   <li>{@code tvbox.d2j.java} = java.exe 路径</li>
 *   <li>{@code tvbox.d2j.cp}   = dex2jar 工具 classpath（resources/jvm/d2j/*.jar）</li>
 *   <li>{@code tvbox.d2j.cache}= 运行时转换产物的缓存目录（缺失则不转换，退回可解释失败）</li>
 * </ul>
 */
public class BaseDexClassLoader extends ClassLoader {

    /**
     * 运行时 dex→jar 产物版本（改「收尾」逻辑时 +1）：
     * 产物名 = `&lt;源归档 md5&gt;.<rev>.jar` —— 老版本产物自然不复用（一次性重转），
     * 避免「旧产物缺 assets / 缺 NEW 修复」被当成好缓存。
     */
    private static final String PRODUCT_REV = ".r2";

    private final String dexPath;
    private final File optimizedDirectory;
    private final String librarySearchPath;

    /** 真正能用的部分：对 jar/zip/apk 用 URLClassLoader 代理。 */
    private URLClassLoader delegate;
    /** 无法处理的条目（转换失败/依赖缺失），首次 loadClass 时用于给出准确报错。 */
    private final List<String> unsupported = new ArrayList<String>();

    public BaseDexClassLoader(String dexPath, File optimizedDirectory,
                              String librarySearchPath, ClassLoader parent) {
        super(parent);
        this.dexPath = dexPath == null ? "" : dexPath;
        this.optimizedDirectory = optimizedDirectory;
        this.librarySearchPath = librarySearchPath;
        this.delegate = buildDelegate(this.dexPath, parent);
        // ★ 2026-09-27（壳通解）：把本加载器登记给原生桥 —— 壳的 native 会用 JNI 调用「解密 dex 里的
        //   真实蜘蛛类」的静态方法（实测 wex：`InitOrigin.init(Context)`），而 unidbg 的反射代理按类名
        //   只在壳加载器里找 → CNFE。登记后桥的类工厂会兜底来这里找（原生桥不在时静默跳过）。
        registerWithBridge(this.delegate);
    }

    private static void registerWithBridge(ClassLoader loader) {
        if (loader == null) return;
        try {
            Class<?> nb = Class.forName("com.winbox.nativebridge.NativeBridge");
            nb.getMethod("registerExtraLoader", ClassLoader.class).invoke(null, loader);
        } catch (Throwable ignored) {
            // 普通源（无原生桥）不影响
        }
    }

    /**
     * ★ 2026-09-27（壳通解·载荷层）：给运行时转换产物打载荷补丁（反射调用，避免编译期耦合）。
     * 桥不在 classpath / 产物无需补丁 / 打补丁失败 → 一律返回 null（原样加载，行为与补丁前一致）。
     */
    private static File patchRuntime(File jar) {
        try {
            Class<?> facade = Class.forName("com.winbox.nativebridge.NativeBridgeMain");
            Object r = facade.getMethod("patchRuntimeJar", File.class).invoke(null, jar);
            if (!(r instanceof File)) return null;
            File dir = (File) r;
            return dir.isDirectory() || dir.mkdirs() ? dir : null;
        } catch (Throwable ignored) {
            return null;
        }
    }

    public BaseDexClassLoader(String dexPath, String optimizedDirectory,
                              String librarySearchPath, ClassLoader parent) {
        this(dexPath, optimizedDirectory == null ? null : new File(optimizedDirectory),
                librarySearchPath, parent);
    }

    /**
     * 把路径里「JVM 能直接读的归档」抽出来交给 URLClassLoader；
     * **裸 .dex（与只含 classes.dex 的归档）就地运行时转换成 jar**（见类注释）。
     *
     * ★ 2026-09-27：**按内容判型，不再只看扩展名**。壳把解密产物落盘时常起名叫
     *   `config.db` / `xxx.bin`（实测 wex：`…/cache/code_cache/sharedb/config.db`），
     *   按扩展名判型会把真实 dex 记成 unsupported → 壳里所有 loadClass 全 CNFE。
     */
    private URLClassLoader buildDelegate(String path, ClassLoader parent) {
        if (path == null || path.isEmpty()) return null;
        List<URL> urls = new ArrayList<URL>();
        for (String p : path.split(File.pathSeparator)) {
            String s = p == null ? "" : p.trim();
            if (s.isEmpty()) continue;
            addEntry(urls, s);
        }
        if (urls.isEmpty()) return null;
        try {
            return new URLClassLoader(urls.toArray(new URL[0]), parent);
        } catch (Throwable th) {
            return null;
        }
    }

    /** 单个路径条目 → URL（dex / 只含 dex 的归档先做运行时 dex→jar 转换；其它 zip 直接挂 URL） */
    private void addEntry(List<URL> urls, String raw) {
        File src = locate(raw);
        if (src == null) {
            unsupported.add(raw);
            return;
        }
        boolean dex = isDexFile(src);
        boolean zip = isZipFile(src);
        if (dex || (zip && isDexOnlyArchive(src.getPath()))) {
            File jar = dexToJar(src);
            if (jar != null) {
                try {
                    // ★ 2026-09-27（壳通解·载荷层）：解密 dex 里的 real 蜘蛛类自带 ARM native
                    //   （wex：LoadNiMa/MyCrypto/GoProxy），其 `<clinit>` 会 `System.load` 自己拷出来的 .so
                    //   → x64 宿主 UnsatisfiedLinkError → ExceptionInInitializerError → 主页全空。
                    //   先给产物打「载荷补丁」（native → 32 位模拟器；System.load → bridgeLoad），
                    //   并把补丁目录排在**原 jar 之前**（类加载顺序覆盖原类）；无需补丁时为 null。
                    File patched = patchRuntime(jar);
                    if (patched != null) urls.add(patched.toURI().toURL());
                    urls.add(jar.toURI().toURL());
                    return;
                } catch (Throwable ignored) {
                    // 落到 unsupported
                }
            }
            unsupported.add(raw);
            return;
        }
        if (zip) {
            try {
                urls.add(src.toURI().toURL());
                return;
            } catch (Throwable ignored) {
                // 落到 unsupported
            }
        }
        unsupported.add(raw);
    }

    /**
     * 路径解析：先按宿主路径找；找不到再试「来宾 POSIX 路径 → 宿主 rootfs」映射
     * （壳落盘路径两种形态都出现过：宿主 `E:\…` 与来宾 `/data/data/…`）。
     */
    private static File locate(String raw) {
        File f = new File(raw);
        if (f.isFile()) return f;
        try {
            Class<?> pf = Class.forName("com.winbox.nativebridge.PosixFile");
            Object r = pf.getMethod("resolveHost", String.class).invoke(null, raw);
            if (r instanceof File && ((File) r).isFile()) return (File) r;
        } catch (Throwable ignored) {
            // 无原生桥（普通源）时按原路径处理
        }
        return null;
    }

    /** dex 判型：扩展名或魔数（`dex\n` / `dey\n`，覆盖 035~039 各版本） */
    private static boolean isDexFile(File f) {
        if (f.getName().toLowerCase().endsWith(".dex")) return true;
        try (InputStream in = new FileInputStream(f)) {
            byte[] h = new byte[8];
            int n = 0;
            while (n < 8) {
                int r = in.read(h, n, 8 - n);
                if (r < 0) break;
                n += r;
            }
            return n == 8 && h[0] == 'd' && h[1] == 'e' && (h[2] == 'x' || h[2] == 'y') && h[3] == '\n';
        } catch (Throwable t) {
            return false;
        }
    }

    /** zip 判型（jar / apk / 任意扩展名的归档都算） */
    private static boolean isZipFile(File f) {
        try (InputStream in = new FileInputStream(f)) {
            byte[] h = new byte[4];
            int n = 0;
            while (n < 4) {
                int r = in.read(h, n, 4 - n);
                if (r < 0) break;
                n += r;
            }
            return n >= 2 && h[0] == 'P' && h[1] == 'K';
        } catch (Throwable t) {
            return false;
        }
    }

    // ---------------------------------------------------------------- 运行时 dex → jar

    /** 归档里只含 dex（没有 JVM 能直接读的 .class）→ 需要转换。读不出来时按「不是 dex 归档」处理。 */
    private static boolean isDexOnlyArchive(String path) {
        try (ZipFile zf = new ZipFile(path)) {
            boolean hasDex = false;
            Enumeration<? extends ZipEntry> it = zf.entries();
            while (it.hasMoreElements()) {
                String n = it.nextElement().getName();
                if (n.endsWith(".class")) return false;
                if (n.equals("classes.dex") || n.matches("classes\\d+\\.dex")) hasDex = true;
            }
            return hasDex;
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * 裸 dex / dex 归档 → jar（运行时 dex2jar，按内容 md5 缓存）。
     * 失败（工具缺失、超时、产物为空）返回 null，调用方按「不可加载」记录并在 loadClass 时报准确原因。
     *
     * ★ 2026-09-27（「代价只付一次」）：两条与宿主侧同口径的纪律 ——
     *   ① **输出写 `<md5>.part.jar` 并重定向到日志文件**（不再读管道）：本 JVM 被宿主 kill 时管道断裂，
     *      子进程往已断的 stdout 写会抛 IOException，反而把「其实还在跑的转换」带崩；
     *   ② **收编上次会话跑完的 part**：JVM 虽然被杀，但 dex2jar 子进程在 Windows 上不会跟着死，
     *      它写完的 part 一直在磁盘上 —— 下次进源直接改名收编即可，不必再等几分钟重转
     *      （用户诉求：「每次打开软件都要等很久」）。
     */
    private static File dexToJar(File src) {
        if (src == null || !src.isFile()) return null;
        String javaExe = System.getProperty("tvbox.d2j.java", "").trim();
        String d2jCp = System.getProperty("tvbox.d2j.cp", "").trim();
        String cacheProp = System.getProperty("tvbox.d2j.cache", "").trim();
        if (javaExe.isEmpty() || d2jCp.isEmpty() || cacheProp.isEmpty()) return null;
        File cache = new File(cacheProp);
        if (!cache.isDirectory() && !cache.mkdirs()) return null;

        String key = md5Of(src);
        if (key == null) return null;
        File out = new File(cache, key + PRODUCT_REV + ".jar");
        if (out.isFile() && out.length() > 0) {
            finalizeProduct(src, out);
            return out;
        }

        File tmp = new File(cache, key + ".part.jar");
        // ★ 收编「上一次会话已经跑完」的转换产物（见方法注释 ②）：省掉整次 dex2jar
        if (isCompleteProduct(tmp) && adoptProduct(tmp, out)) {
            finalizeProduct(src, out);
            return out;
        }

        List<String> argv = new ArrayList<String>();
        argv.add(javaExe);
        // 堆按源体积自适应（与宿主 JarSpiderBridge 同口径）：~128MB/1MB，夹在 [512, 1792]
        long mb = Math.max(1L, src.length() / (1024L * 1024L));
        argv.add("-Xmx" + Math.min(1792L, Math.max(512L, mb * 128L + 256L)) + "m");
        argv.add("-XX:+UseSerialGC");
        argv.add("-XX:TieredStopAtLevel=1");
        argv.add("-XX:ReservedCodeCacheSize=32m");
        argv.add("-Dfile.encoding=UTF-8");
        argv.add("-cp");
        argv.add(d2jCp);
        argv.add("com.googlecode.dex2jar.tools.Dex2jarCmd");
        argv.add(src.getAbsolutePath());
        argv.add("-o");
        argv.add(tmp.getAbsolutePath());
        argv.add("--force");
        try {
            ProcessBuilder pb = new ProcessBuilder(argv);
            pb.redirectErrorStream(true);
            // ★ 输出重定向到日志文件（见方法注释 ①）：宿主 kill 本 JVM 后管道必断，落文件才安全；
            //   顺带把 dex2jar 的报错留档（此前只在内存里，JVM 一死就没了）。
            boolean toFile = false;
            try {
                pb.redirectOutput(ProcessBuilder.Redirect.to(new File(cache, key + ".d2j.log")));
                toFile = true;
            } catch (Throwable ignored) {
                // 落文件失败 → 退化为「吞掉输出」，绝不能让它写满 64KB 管道卡死子进程
            }
            Process proc = pb.start();
            if (!toFile) {
                try (InputStream in = proc.getInputStream()) {
                    byte[] buf = new byte[8192];
                    while (in.read(buf) > 0) {
                        // discard
                    }
                } catch (Throwable ignored) {
                }
            }
            if (!proc.waitFor(15, java.util.concurrent.TimeUnit.MINUTES)) {
                proc.destroyForcibly();
                return null;
            }
            if (proc.exitValue() != 0 || !tmp.isFile() || tmp.length() == 0) {
                try { tmp.delete(); } catch (Throwable ignored) { }
                return null;
            }
            if (!tmp.renameTo(out) && !out.isFile()) {
                // 竞态下别的线程已生成同名产物也算成功
                if (!out.isFile()) return null;
            }
            if (!out.isFile() || out.length() <= 0) return null;
            finalizeProduct(src, out);
            return out;
        } catch (Throwable t) {
            return null;
        }
    }

    /**
     * ★ 2026-09-27（新订阅 96 源全空）**产物收尾**：补 assets + 修 NEW 抽象类（见类注释）。
     * 用标记文件 `&lt;产物&gt;.fix.ok` 保证只做一次；任一步失败都只记日志，不影响产物可用性。
     */
    private static void finalizeProduct(File src, File out) {
        try {
            File mark = new File(out.getParentFile(), out.getName() + ".fix.ok");
            if (mark.isFile()) return;
            int copied = copyArchiveResources(src, out);
            int fixed = repairNewSites(src, out);
            System.err.println("[runtime-dex] 产物收尾 " + out.getName()
                    + "：补资源 " + copied + " 项，修 NEW 抽象类 " + (fixed < 0 ? "跳过" : fixed + " 处"));
            try {
                java.nio.file.Files.write(mark.toPath(), "ok".getBytes("UTF-8"));
            } catch (Throwable ignored) {
                // 标记写不出（只读盘）→ 下次再收尾一次，幂等
            }
        } catch (Throwable t) {
            System.err.println("[runtime-dex] 产物收尾失败（继续按产物加载）: " + t);
        }
    }

    /**
     * 把源归档里**非 class 条目**补进转换产物（实测 wex 载荷：`assets/libwex_v7.so` /
     * `assets/libwex_v8.so` —— 载荷类 `<clinit>` 会 `getResourceAsStream("assets/libwex_v8.so")`
     * 把 .so 拷出来再 `System.load`，dex2jar 只产 .class ⇒ 不补就恒 null → NPE → 主页全空）。
     * 幂等：产物里已有的条目跳过；有条目缺失时写临时文件再原子替换。
     *
     * @return 补进去的条目数；源不是 zip / 出错 → 0
     */
    private static int copyArchiveResources(File src, File out) {
        if (src == null || out == null || !src.isFile() || !out.isFile()) return 0;
        java.io.File tmp = new java.io.File(out.getParentFile(), out.getName() + ".fix.tmp");
        try {
            java.util.List<String> outNames = new ArrayList<String>();
            java.util.Map<String, byte[]> outData = new java.util.LinkedHashMap<String, byte[]>();
            java.util.List<String> outOrder = new ArrayList<String>();
            java.util.Map<String, byte[]> missing = new java.util.LinkedHashMap<String, byte[]>();
            try (ZipFile zo = new ZipFile(out); ZipFile zs = new ZipFile(src)) {
                Enumeration<? extends ZipEntry> it = zo.entries();
                while (it.hasMoreElements()) {
                    ZipEntry e = it.nextElement();
                    if (e.isDirectory()) continue;
                    outNames.add(e.getName());
                    outOrder.add(e.getName());
                    outData.put(e.getName(), readAllBytes(zo.getInputStream(e)));
                }
                Enumeration<? extends ZipEntry> si = zs.entries();
                while (si.hasMoreElements()) {
                    ZipEntry e = si.nextElement();
                    String n = e.getName();
                    if (e.isDirectory() || n.endsWith(".class") || n.equals("classes.dex")
                            || n.matches("classes\\d+\\.dex") || n.equals("META-INF/MANIFEST.MF")) continue;
                    if (outNames.contains(n)) continue;
                    missing.put(n, readAllBytes(zs.getInputStream(e)));
                }
            }
            if (missing.isEmpty()) return 0;
            try (java.util.zip.ZipOutputStream zos = new java.util.zip.ZipOutputStream(new java.io.FileOutputStream(tmp))) {
                for (String n : outOrder) {
                    zos.putNextEntry(new ZipEntry(n));
                    zos.write(outData.get(n));
                    zos.closeEntry();
                }
                for (java.util.Map.Entry<String, byte[]> e : missing.entrySet()) {
                    zos.putNextEntry(new ZipEntry(e.getKey()));
                    zos.write(e.getValue());
                    zos.closeEntry();
                }
            }
            java.nio.file.Files.move(tmp.toPath(), out.toPath(),
                    java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            return missing.size();
        } catch (Throwable t) {
            try { tmp.delete(); } catch (Throwable ignored) { }
            return 0;
        }
    }

    /**
     * 修 dex2jar 的「NEW 抽象类」误译（详见 native-bridge 的 `DexJarRepair`）：
     * 反射调用（桥不在 / 属性缺失 → -1，跳过）。
     */
    private static int repairNewSites(File dex, File out) {
        try {
            Class<?> c = Class.forName("com.winbox.nativebridge.DexJarRepair");
            Object r = c.getMethod("repair", File.class, File.class, String.class, String.class)
                    .invoke(null, dex, out,
                            System.getProperty("tvbox.d2j.java", "java"),
                            System.getProperty("tvbox.d2j.cp", ""));
            return r instanceof Integer ? ((Integer) r).intValue() : 0;
        } catch (Throwable t) {
            return -1;
        }
    }

    /** 读完整流（小文件用；assets 级别几 MB 可接受） */
    private static byte[] readAllBytes(InputStream in) throws IOException {
        try {
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return bos.toByteArray();
        } finally {
            in.close();
        }
    }

    /** 产物是否「写完整」：能作为 zip 打开且至少有一个 .class（写一半被杀的文件没有中央目录）。 */
    private static boolean isCompleteProduct(File f) {
        if (f == null || !f.isFile() || f.length() == 0) return false;
        try (ZipFile zf = new ZipFile(f)) {
            Enumeration<? extends ZipEntry> it = zf.entries();
            while (it.hasMoreElements()) {
                if (it.nextElement().getName().endsWith(".class")) return true;
            }
            return false;
        } catch (Throwable t) {
            return false;
        }
    }

    /** 把已经写完的 part 收编为正式产物（尽力而为；失败只当作没赶上，下次照常重转）。 */
    private static boolean adoptProduct(File part, File out) {
        try {
            if (out.isFile() && !out.delete()) return false;
            if (part.renameTo(out)) return true;
            return out.isFile() && out.length() > 0;
        } catch (Throwable t) {
            return false;
        }
    }

    /** 流式 md5（dex 可能几十 MB，不能整读进内存）。失败返回 null。 */
    private static String md5Of(File f) {
        try (InputStream in = new FileInputStream(f)) {
            MessageDigest md = MessageDigest.getInstance("MD5");
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
            StringBuilder sb = new StringBuilder();
            for (byte b : md.digest()) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Throwable t) {
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
                    + "（桌面版无法加载：该路径含 " + unsupported
                    + "；裸 dex 需宿主注入 tvbox.d2j.* 才能运行时转换）");
        }
        throw new ClassNotFoundException(name);
    }

    /** 兜底：某些壳只用 loadClass，不走 findClass（本类直接委托）。 */
    @Override
    public Class<?> loadClass(String name) throws ClassNotFoundException {
        Class<?> c = null;
        try {
            c = super.loadClass(name);
        } catch (ClassNotFoundException ignored) {
            // 父加载器没有 → 尝试自己
        }
        if (c != null) return c;
        return findClass(name);
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
