package com.winbox.nativebridge;

import java.io.File;
import java.io.RandomAccessFile;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Map;

/**
 * 原生桥对外的**唯一门面**（蜘蛛运行器只反射这一个类，避免编译期耦合）。
 *
 * 调用约定：SpiderRunner 在建立蜘蛛类加载器之前反射调用
 *   `prepare(File jar, File workDir, File outDir, ClassLoader resolver)`，
 * 成功返回人话报告，并把改写产物写到 outDir（调用方须把 outDir 排在 URL 最前）。
 * 失败抛异常：调用方按「无原生桥」降级（jar 原样加载）并清掉 outDir，避免旧产物遮蔽新 jar。
 *
 * ★ 并发（一 jar 多源：摸鱼 115 个源共用一只 jar → 池会并行起多个进程）：
 *   多个进程会对**同一 outDir** 调 prepare。这里用「状态戳 + 跨进程文件锁」保证
 *   同一 jar 状态只改写一次，其余进程直接复用 —— 否则会出现
 *   「A 进程正在载入类、B 进程刚把目录删掉重写」的半成品读取（类缺失/格式错）。
 */
public final class NativeBridgeMain {

    /**
     * ★ 桥 / 改写器版本号：**改写逻辑或产物格式一变就 +1**。
     * 它参与状态键，用于让磁盘上的旧改写产物失效 —— 否则升级后
     * （jar 体积/时间、.so、改写计划都没变）会直接复用旧产物，修好的逻辑不生效。
     * rev3 = `.so` 落地改「同内容复用 + 内容寻址兜底」（修多进程 mmap 覆盖失败，见 NativeBridge.landSo）。
     * rev4 = 新增「库加载中性化」：被改写类里的 System/Runtime.load* 视为已加载（壳只差 System.load 就肯走原生路径）。
     */
    private static final int BRIDGE_REV = 4;

    /**
     * ★ 载荷补丁版本号（改写逻辑或产物格式一变就 +1）：解密 dex 的产物补丁参与状态键，
     * 否则升级后（jar 体积/时间没变）会复用旧补丁，修好的逻辑不生效。
     * rev1 = 载荷层首版：全量 native → `NativeBridge.invokePayload`；`System.load(String)` → `bridgeLoad`。
     * rev2 = `<clinit>` 改名 + 合成受保护的新 `<clinit>`（缺库不再抛 ExceptionInInitializerError，失败点前移到调用处）。
     */
    private static final int PAYLOAD_REV = 3;

    private NativeBridgeMain() {
    }

    /**
     * ★ 2026-09-27（实测「第一次进源必空」修复）：只把「惰性初始化上下文」重新登记给桥。
     *
     * <p>调用方纪律（勿回退）：改写产物要**先写好、再建正式 URLClassLoader** —— 反序时
     * URLClassLoader 对目录 URL 会缓存一次（当时还是空目录的）列表，改写类「写好了却加载不到」，
     * 同一 JVM 首次调用落到原始 DexNative（System.load ARM .so → UnsatisfiedLinkError）。
     * 于是流程改为：临时 loader（只含蜘蛛 jar）做改写 → 建正式 loader（改写目录在最前）→
     * 本方法把正式 loader 重新 arm 给桥（惰性初始化/类工厂用它解析壳类）。
     */
    public static void arm(File jar, File workDir, ClassLoader resolver) {
        if (!NativeBridge.available() || jar == null || workDir == null) return;
        NativeBridge.arm(jar, workDir, resolver);
    }

    /**
     * ★★ 2026-09-27（实测「第一次进源必空」第二环，勿回退）★★
     * 用**正式加载器**重新初始化桥（`NativeBridge.init` 可重入）。
     *
     * <p>背景：改写产物必须「先写好、再建正式 URLClassLoader」（见 {@link #arm} 注释），
     * 所以 prepare 拿到的是**临时加载器**（只含蜘蛛 jar）。而 init 会把 resolver 捕获进
     * 「壳类工厂 / EnvJni host loader / Context.getClassLoader()」——临时加载器与正式加载器
     * 不是同一个 → 原生侧 `Context.getClassLoader()` 上取的 jmethodID 拿到 `Init.classLoader()`
     * 上调用时对不上（实测：`main WARN ProxyJni - callStaticObjectMethod` +
     * `msg=com/github/catvod/spider/Init->classLoader()` emulation 异常 → getLoader 崩 → 源全空）。
     * 正式加载器建好后调本方法，把整套绑定换到正式加载器上。
     */
    public static void rebind(File jar, File workDir, ClassLoader resolver) throws Exception {
        if (!NativeBridge.available() || jar == null || workDir == null || resolver == null) return;
        NativeBridge.init(jar, workDir, resolver);
    }

    public static String prepare(File jar, File workDir, File outDir, ClassLoader resolver) throws Exception {
        if (!NativeBridge.available()) {
            throw new IllegalStateException("原生运行时缺失（unidbg 不在 classpath）");
        }

        // ★★ 廉价键（不启模拟器、不扫描 11MB jar）：桥版本 + jar 体积/时间 + .so 身份。
        //    它命中就说明「改写产物仍然有效」——直接复用，模拟器推迟到首次原生调用（见 NativeBridge.ensureInit）。
        //    真机实测：整条 10s 初始化里，模拟器启动 + jar 扫描 + 注册占绝对大头，而多数源全程不调 native。
        String[] soId = NativeBridge.soIdentity(jar);
        String cheap = BRIDGE_REV + "/" + jar.length() + "/" + jar.lastModified() + "/" + soId[0] + "/" + soId[1];

        File parent = outDir.getParentFile() == null ? new File(".") : outDir.getParentFile();
        File stamp = new File(parent, outDir.getName() + ".ok");
        File lockPath = new File(parent, outDir.getName() + ".lock");
        if (hasArtifacts(outDir) && readText(stamp).startsWith(cheap + "/")) {
            NativeBridge.arm(jar, workDir, resolver);
            return "原生桥改写产物复用（同 jar/.so）——原生实现将于首次调用时按需启动";
        }

        int patched;
        try (RandomAccessFile lockFile = new RandomAccessFile(lockPath, "rw");
             FileChannel channel = lockFile.getChannel();
             FileLock ignored = channel.lock()) {
            // 双检：等锁期间可能已有别的进程改写完成
            if (hasArtifacts(outDir) && readText(stamp).startsWith(cheap + "/")) {
                NativeBridge.arm(jar, workDir, resolver);
                return "原生桥改写产物已由其它进程写入——原生实现将于首次调用时按需启动";
            }
            NativeBridge.init(jar, workDir, resolver);
            Map<String, Map<String, Boolean>> plan = NativeBridge.plan();
            if (plan.isEmpty()) {
                throw new IllegalStateException("该 .so 没有可改写的 native 方法（无需原生桥）");
            }
            deleteRecursively(outDir);
            if (!outDir.exists() && !outDir.mkdirs()) throw new java.io.IOException("mkdirs failed: " + outDir);
            patched = NativePatcher.patch(jar, outDir, plan, resolver);
            writeText(stamp, cheap + "/" + plan.toString().hashCode()); // 完整键 = 廉价键 + 计划指纹
        }
        String rep = NativeBridge.report() + "\n  · 已改写 " + patched + " 个方法 → " + outDir.getAbsolutePath()
                + (NativePatcher.skipped > 0 ? "\n  · 已中性化 " + NativePatcher.skipped + " 个类的库加载（System.load → 由桥提供）" : "");
        System.err.println("[native-bridge] " + rep.replace("\n", "\n[native-bridge] "));
        return rep;
    }

    /**
     * ★★ 2026-09-27（壳通解·载荷层）：给**运行时 dex 产物**打载荷补丁。
     *
     * <p>背景：壳把 assets 解密成明文 dex，dex 里的真实蜘蛛类自带 ARM native
     * （wex：`LoadNiMa`/`MyCrypto`/`GoProxy`）。它们的 `<clinit>` 自己 `System.load(绝对路径)`
     * → 宿主 x64 抛 `UnsatisfiedLinkError` → `ExceptionInInitializerError` → 主页全空。
     * 补丁做两件事（见 NativePatcher.patchPayload）：native → `NativeBridge.invokePayload`，
     * `System.load(String)` → `NativeBridge.bridgeLoad(path)`（把 ARM .so 装进模拟器）。
     *
     * <p>调用方纪律（同壳 jar）：把返回目录排在**原 jar 之前**（类加载顺序覆盖原类）。
     * 状态戳 + 跨进程文件锁与壳补丁同口径（同一只产物会被池里的多个 JVM 同时请求）。
     *
     * @return 补丁目录；无需补丁（无 native 也无库加载调用）或失败时返回 null（调用方原样加载）
     */
    public static File patchRuntimeJar(File jar) {
        try {
            if (jar == null || !jar.isFile() || !NativeBridge.available()) return null;
            String cacheProp = System.getProperty("tvbox.d2j.cache", "").trim();
            if (cacheProp.isEmpty()) return null; // 宿主未注入 d2j 缓存（无原生桥的普通运行）
            File cache = new File(cacheProp);
            if (!cache.isDirectory() && !cache.mkdirs()) return null;
            File outDir = new File(cache, jar.getName() + ".patched");
            String cheap = PAYLOAD_REV + "/" + jar.length() + "/" + jar.lastModified();
            File stamp = new File(cache, outDir.getName() + ".ok");
            File lockPath = new File(cache, outDir.getName() + ".lock");
            if (hasArtifacts(outDir) && readText(stamp).startsWith(cheap + "/")) return outDir;

            int written;
            try (RandomAccessFile lockFile = new RandomAccessFile(lockPath, "rw");
                 FileChannel channel = lockFile.getChannel();
                 FileLock ignored = channel.lock()) {
                if (hasArtifacts(outDir) && readText(stamp).startsWith(cheap + "/")) return outDir;
                deleteRecursively(outDir);
                if (!outDir.exists() && !outDir.mkdirs()) return null;
                written = patchPayloadWith(jar, outDir);
                if (written <= 0) {
                    deleteRecursively(outDir); // 该产物没有需要改写的类 → 不留空目录（否则会遮蔽原 jar 的目录语义）
                    return null;
                }
                writeText(stamp, cheap + "/" + written);
            }
            System.err.println("[native-bridge] 运行时 dex 载荷补丁就绪: " + outDir.getName() + "（" + written
                    + " 个类：native → 载荷桥，System.load → bridgeLoad）");
            return outDir;
        } catch (Throwable t) {
            System.err.println("[native-bridge] 运行时 dex 载荷补丁失败（原样加载）: " + t);
            return null;
        }
    }

    /** 帧计算用的解析加载器：能看见该 dex 自己的类（否则改写时父类全退化成 Object，帧计算容易错） */
    private static int patchPayloadWith(File jar, File outDir) throws Exception {
        URLClassLoader resolver = new URLClassLoader(new URL[]{jar.toURI().toURL()}, NativeBridgeMain.class.getClassLoader());
        try {
            return NativePatcher.patchPayload(jar, outDir, resolver);
        } finally {
            try {
                resolver.close();
            } catch (Throwable ignored) {
                // 关不掉不影响正确性
            }
        }
    }

    /**
     * 产物目录里确实还有东西才算「已是最新」：状态戳与锁都落在 outDir **之外**
     * （outDir 的父目录），单独删掉产物目录会留下陈旧戳 → 桥会静默跳过重写，
     * 调用方拿到一个空的改写目录（表现成「桥未就绪」而不是「未改写」，极难排查）。
     */
    private static boolean hasArtifacts(File dir) {
        if (dir == null || !dir.isDirectory()) return false;
        File[] kids = dir.listFiles();
        return kids != null && kids.length > 0;
    }

    private static String readText(File f) {
        try {
            return f.isFile() ? new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8).trim() : "";
        } catch (Throwable t) {
            return "";
        }
    }

    private static void writeText(File f, String text) {
        try {
            Files.write(f.toPath(), text.getBytes(StandardCharsets.UTF_8));
        } catch (Throwable t) {
            System.err.println("[native-bridge] 写状态戳失败（下次会重写）: " + t);
        }
    }

    private static void deleteRecursively(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) {
            for (File k : kids) deleteRecursively(k);
        }
        // noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
