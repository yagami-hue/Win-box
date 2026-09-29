package com.winbox.nativebridge;

import com.github.unidbg.AndroidEmulator;
import com.github.unidbg.Module;
import com.github.unidbg.arm.backend.BackendFactory;
import com.github.unidbg.arm.backend.Unicorn2Factory;
import com.github.unidbg.linux.android.AndroidEmulatorBuilder;
import com.github.unidbg.linux.android.AndroidResolver;
import com.github.unidbg.linux.android.dvm.DalvikModule;
import com.github.unidbg.linux.android.dvm.DvmClass;
import com.github.unidbg.linux.android.dvm.DvmObject;
import com.github.unidbg.linux.android.dvm.Hashable;
import com.github.unidbg.linux.android.dvm.VM;
import com.github.unidbg.linux.android.dvm.array.ArrayObject;
import com.github.unidbg.linux.android.dvm.jni.ProxyDvmObject;
import com.github.unidbg.virtualmodule.android.AndroidModule;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.WeakHashMap;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;

/**
 * ARM 原生桥 —— 在 Windows x64 上用 unidbg 执行 jar 内的 AArch64/ARM32 `.so`，
 * 并把 jar 里「声明为 native 的方法」改写成转发调用（见 NativePatcher）。
 *
 * 关键链路（Spike 实测，勿改口径）：
 *  ① `.so` 在 `assets/` 下（如 FishGuard-v8.so / -v7.so），DT_NEEDED 只需 libc/libm/liblog/libdl
 *     （unidbg-android jar 内置 sdk23 系统库，无需另找）；
 *  ② `JNI_OnLoad` 通常**什么都不注册**；真正的 RegisterNatives 在 Java 侧调用的
 *     `register()`（导出符号 `Java_<类>_register`）里 —— 桥必须主动触发它；
 *  ③ 触发时原生代码会**回调 Java 要 Android 环境**（`Init.context()` → Application → `getFilesDir()`），
 *     由 ProxyClassFactory（反射代理真实类）+ EnvJni（目录路径垫片）共同兜住；
 *  ④ 注册完成后用反射读 `DvmClass.nativesMap` 得到「方法名+描述符 → 函数指针」全表，
 *     据此生成改写计划。
 */
public final class NativeBridge {

    private static AndroidEmulator emulator;
    private static VM vm;
    private static Module module;
    private static int archBits = 64;
    private static String soName = "";
    private static long soSize = 0;
    private static String report = "";

    // ---------------- 载荷层（运行时 dex 里的 native）状态 ----------------
    //
    // 见 invokePayload / bridgeLoad 注释：壳（64 位）与载荷（多为 ARM32）各用一只模拟器，
    // 两者互不影响；PAYLOAD_LIBS 记录「System.load 请求路径 → 装载结果」供诊断。
    private static AndroidEmulator payloadEmulator;
    private static VM payloadVm;
    private static String payloadReport = "";
    /** 是否出现过「AArch64 载荷」——那种情况与壳共用 64 位模拟器（见 payloadLoad / invokePayload） */
    private static volatile boolean payloadInShell;
    private static final Map<String, String> PAYLOAD_LIBS = new LinkedHashMap<>();

    // ---------------- 惰性初始化（★ 2026-09-26：按需付费） ----------------
    //
    // 背景（真机实测）：模拟器启动 + 11MB jar 扫描 + 注册 = **约 10 秒**；而多数源整条请求
    // 根本不调用 native（桥开/桥关结果逐项一致）。每次 JVM 冷启都付 10s 就是「进源慢」的根因。
    // 因此：改写产物在本进程里**直接复用**（不启模拟器），只登记「首次调用原生时再初始化」。
    private static volatile boolean inited;
    private static File lazyJar;
    private static File lazyWork;
    private static ClassLoader lazyResolver;

    /** 登记惰性初始化所需的上下文（改写产物已就绪、模拟器推迟到首次 invoke；不改 inited） */
    public static void arm(File jar, File workDir, ClassLoader resolver) {
        lazyJar = jar;
        lazyWork = workDir;
        lazyResolver = resolver;
    }

    /** 首次原生调用前确保模拟器已就绪（可能耗时数秒，只付一次） */
    static synchronized void ensureInit() throws Exception {
        if (inited) return;
        long t0 = System.currentTimeMillis();
        init(lazyJar, lazyWork, lazyResolver);
        System.err.println("[native-bridge] 原生实现已按需启动（首次调用）耗时 " + (System.currentTimeMillis() - t0) + "ms");
    }

    /** .so 身份（不落盘、不启模拟器；供状态键与「廉价键」判重） */
    static String[] soIdentity(File jar) throws Exception {
        try (JarFile jf = new JarFile(jar)) {
            Enumeration<JarEntry> it = jf.entries();
            String best = null;
            long bestScore = -1;
            long bestSize = 0;
            while (it.hasMoreElements()) {
                JarEntry e = it.nextElement();
                String name = e.getName();
                if (e.isDirectory() || !name.endsWith(".so")) continue;
                byte[] head = new byte[20];
                try (InputStream is = jf.getInputStream(e)) {
                    int n = 0;
                    while (n < head.length) {
                        int r = is.read(head, n, head.length - n);
                        if (r < 0) break;
                        n += r;
                    }
                }
                int bits = elfBits(head);
                if (bits == 0) continue;
                long score = bits == 64 ? 2 : 1;
                if (score > bestScore) {
                    bestScore = score;
                    best = new File(name).getName();
                    bestSize = e.getSize();
                }
            }
            if (best == null) throw new IllegalStateException("jar 内没有可用的 ARM .so: " + jar.getName());
            return new String[]{best, String.valueOf(bestSize)};
        }
    }

    /** 已就绪的 DVM 类（改写后的方法经 invoke 只能访问这里登记过的类） */
    private static final Map<String, DvmClass> CLASSES = new LinkedHashMap<>();

    /**
     * ★ 2026-09-27（壳通解）：真 Java 对象 → DvmObject 包装缓存。
     *   同一真对象跨多次调用必须拿到同一个 DvmObject（哈希一致），否则原生侧对
     *   「同一个 loader / context」的判等会失真；Weak 防长跑进程里堆住蜘蛛对象。
     *   ★ 按 VM 分桶：DvmObject 属于某一只 VM，壳（64 位）与载荷（32 位）各有自己的表，
     *     混用会把另一只 VM 的对象塞进调用参数（unidbg 侧直接类型错乱）。
     */
    private static final Map<VM, Map<Object, DvmObject<?>>> WRAPPED = new WeakHashMap<VM, Map<Object, DvmObject<?>>>();

    /** 改写计划：类（内部名） → (方法名+描述符 → true=只当空实现（注册入口），false=转发到 .so) */
    private static final Map<String, Map<String, Boolean>> PLAN = new LinkedHashMap<>();

    /**
     * ★★ 模拟器锁：**每只模拟器一把**（unidbg 非线程安全，但两只模拟器互不相干）。
     *
     * <p>为什么不能只用一把全局锁（2026-09-27 真机死锁取证，勿回退）：
     * 壳的 native 会**回调 Java**（如 `DexNative.getLoader` → `InitOrigin.init(ctx)`），
     * 而 `InitOrigin.init` 会等一个 CountDownLatch —— 计数由蜘蛛自己的线程在
     * `LoadNiMa.init(...)`（载荷 native）之后减一。若两处共用一把锁：
     * main 持锁跑壳 native ↔ 蜘蛛线程排队等锁，谁都不让谁 → 线程转储里
     * 「main 在 emu_start 里等 CountDownLatch，Thread-4 在 invokePayload 等锁」永久互等。
     * 壳（64 位）与载荷（32 位）本就是两只模拟器，各锁各的即可并行推进。
     */
    private static final Object LOCK = new Object();
    /** 载荷（32 位）模拟器锁；壳 64 位载荷库走 {@link #LOCK}（与壳同属那只模拟器） */
    private static final Object PAYLOAD_LOCK = new Object();
    /** 「真对象 → DvmObject」缓存表自身的锁（两张表分属两个 VM） */
    private static final Object WRAPPED_LOCK = new Object();
    private static final Object[] NO_ARGS = new Object[0];

    private NativeBridge() {
    }

    /** 桥是否可用（classpath 里有 unidbg 才成立；缺库时调用方应直接跳过改写） */
    public static boolean available() {
        try {
            Class.forName("com.github.unidbg.linux.android.AndroidEmulatorBuilder", false, NativeBridge.class.getClassLoader());
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    public static String report() {
        return report;
    }

    /** 已加载的 .so 名（报告用） */
    static String soName() {
        return soName;
    }

    /** 已加载的 .so 体积（报告用） */
    static long soSize() {
        return soSize;
    }

    public static Map<String, Map<String, Boolean>> plan() {
        return PLAN;
    }

    /**
     * 初始化桥：提取 .so → 起模拟器 → loadLibrary + JNI_OnLoad → 触发 register() → 汇总注册表。
     *
     * @param jar      已转换的蜘蛛 jar（含 assets/**.so）
     * @param workDir  桥工作目录（.so 落地 + 来宾 rootfs，建议 <userData>/cache/native/work/<jarKey>）
     * @param resolver 蜘蛛类加载器（让原生回调能反射到真实的 Init / android stub）
     */
    public static synchronized void init(File jar, File workDir, ClassLoader resolver) throws Exception {
        long t0 = System.currentTimeMillis();
        File soDir = new File(workDir, "so");
        File rootfs = new File(workDir, "rootfs");
        // noinspection ResultOfMethodCallIgnored
        soDir.mkdirs();
        // noinspection ResultOfMethodCallIgnored
        rootfs.mkdirs();

        File so = extractSo(jar, soDir);
        soName = so.getName();
        soSize = so.length();
        archBits = detectArchBits(so);

        AndroidEmulatorBuilder builder = archBits == 32
                ? AndroidEmulatorBuilder.for32Bit()
                : AndroidEmulatorBuilder.for64Bit();
        builder.setProcessName("com.winbox.spider");
        builder.setRootDir(rootfs);
        builder.addBackendFactory(backendFactory());
        emulator = builder.build();
        emulator.getMemory().setLibraryResolver(new AndroidResolver(23));
        emulator.getSyscallHandler().setEnableThreadDispatcher(true);
        PosixFile.setRootfs(emulator.getFileSystem().getRootDir());

        vm = emulator.createDalvikVM();
        EnvJni shim = new EnvJni(null);
        // ★ 2026-09-27（壳通解）：把「壳类加载器」交给 EnvJni —— Context.getClassLoader() 必须返回它，
        //   否则原生在 context.getClassLoader() 上取 jmethodID、再到 Init.classLoader() 上调用时
        //   会因两个加载器的类不同而查不到方法（BackendException），且 getResourceAsStream 也读不到
        //   壳 jar 的 assets/**。详见 EnvJni.setHostLoader 注释。
        EnvJni.setHostLoader(resolver == null ? NativeBridge.class.getClassLoader() : resolver);
        BridgeClassFactory factory = new BridgeClassFactory(resolver == null ? NativeBridge.class.getClassLoader() : resolver, shim);
        factory.configClassNameMapper(name -> {
            if ("java/io/File".equals(name)) return PosixFile.class; // 见 PosixFile 注释（POSIX 路径 + rootfs 落盘）
            try {
                return Class.forName(name.replace('/', '.'), false, factoryLoader(resolver));
            } catch (Throwable t) {
                // 壳加载器没有 → 可能是「解密 dex 里的真实蜘蛛类」（native 会 JNI 调它的静态方法）
                return loadExtra(name.replace('/', '.'));
            }
        });
        factory.setFallbackJni(shim);
        vm.setDvmClassFactory(factory);
        vm.setJni(shim);
        // 调试开关（-Dtvbox.native.debug=1）：打印全部 JNI 调用（定位「native 回调拿到 null」一类问题）
        if ("1".equals(System.getProperty("tvbox.native.debug"))) {
            vm.setVerbose(true);
            System.err.println("[native-bridge] 调试模式：JNI verbose 已开启");
        }

        // ★ 2026-09-27 壳通解：注册 unidbg 的 **libandroid 虚拟模块**（AAssetManager_fromJava/open、
        //   AAsset_getBuffer/getLength/read/close），并把 jar 内 assets/** 喂进去。
        //   加固壳的 native 普遍用 AAssetManager 读自己的加密数据（实测 wex：`assets/wexshinidie.guard`）；
        //   缺这个模块时 .so 的 DT_NEEDED libandroid.so 解析不了 → 那几个导入符号为 0 →
        //   native 一调用就 BackendException（现象：getLoader 崩、后续 BaseSpiderGuard NPE）。
        //   必须在 loadLibrary **之前**注册，否则导入符号已经绑定成 0。
        installAssets(jar, soName);

        DalvikModule dm = vm.loadLibrary(so, true);
        module = dm.getModule();
        dm.callJNI_OnLoad(emulator);

        Map<String, List<String[]>> nativeMethods = scanNativeMethods(jar);
        List<String> notes = new ArrayList<>();
        for (Map.Entry<String, List<String[]>> e : nativeMethods.entrySet()) {
            String cls = e.getKey();
            DvmClass dvmClass = vm.resolveClass(cls);
            if (nativesCount(dvmClass) > 0) continue; // JNI_OnLoad 已注册
            for (String[] m : e.getValue()) {
                if (!"()V".equals(m[1])) continue; // 注册入口约定为「无参 void」
                String symbol = "Java_" + mangle(cls) + "_" + mangle(m[0]);
                if (module.findSymbolByName(symbol, false) == null) continue;
                try {
                    dvmClass.callStaticJniMethod(emulator, m[0] + "()V");
                } catch (Throwable t) {
                    notes.add("触发 " + cls + "." + m[0] + "() 失败: " + t);
                    continue;
                }
                int n = nativesCount(dvmClass);
                if (n > 0) {
                    notes.add("经 " + cls.substring(cls.lastIndexOf('/') + 1) + "." + m[0] + "() 注册 " + n + " 个 native");
                    // 注册入口本身在 Java 侧仍会被调用 → 改写成空实现，避免 UnsatisfiedLinkError
                    PLAN.computeIfAbsent(cls, k -> new LinkedHashMap<>()).put(m[0] + "()V", true);
                    break;
                }
            }
        }

        int total = 0;
        for (Map.Entry<String, List<String[]>> e : nativeMethods.entrySet()) {
            DvmClass dvmClass = vm.resolveClass(e.getKey());
            Map<String, ?> natives = nativesMap(dvmClass);
            if (natives.isEmpty()) continue;
            CLASSES.put(e.getKey(), dvmClass);
            Map<String, Boolean> plan = PLAN.computeIfAbsent(e.getKey(), k -> new LinkedHashMap<>());
            for (String key : natives.keySet()) plan.put(key, false);
            total += natives.size();
        }

        StringBuilder sb = new StringBuilder();
        sb.append("原生桥就绪：").append(soName).append(" (").append(soSize).append("B, ").append(archBits).append(" 位)")
                .append("，注册 native ").append(total).append(" 个");
        for (Map.Entry<String, Map<String, Boolean>> e : PLAN.entrySet()) {
            sb.append("\n  - ").append(e.getKey()).append(" → 改写 ").append(e.getValue().size()).append(" 个方法");
        }
        for (String n : notes) sb.append("\n  · ").append(n);
        sb.append("\n  · 初始化耗时 ").append(System.currentTimeMillis() - t0).append("ms");
        report = sb.toString();
        inited = true;
    }

    private static ClassLoader factoryLoader(ClassLoader resolver) {
        return resolver == null ? NativeBridge.class.getClassLoader() : resolver;
    }

    /**
     * 模拟后端工厂。★ 2026-09-28（FishGuard 壳性能专项）定为 **Dynarmic 默认**：
     *   FishGuard 壳的 AES 走控制流平坦化 VM，总指令量巨大 —— Unicorn2 后端单次 Dec 12~30s
     *   （NiuLai home 200s+ 打满 300s 预算），Dynarmic（JIT）单次 0.7~1.7s、home 20~30s，实测快 15~20 倍。
     *   逃生开关：`-Dtvbox.native.backend=unicorn2` 强制旧后端；dynarmic 类不在 classpath（老安装未下
     *   载 unidbg-dynarmic.jar）时自动回退 Unicorn2。布尔参数 true = 创建失败回退 Unicorn，不炸整条桥。
     */
    private static BackendFactory backendFactory() {
        if (!"unicorn2".equalsIgnoreCase(System.getProperty("tvbox.native.backend", ""))) {
            try {
                Class<?> f = Class.forName("com.github.unidbg.arm.backend.DynarmicFactory");
                System.err.println("[native-bridge] 模拟后端: dynarmic（JIT）");
                return (BackendFactory) f.getConstructor(boolean.class).newInstance(true);
            } catch (Throwable t) {
                System.err.println("[native-bridge] dynarmic 后端不可用（按需下载后首次生效），回退 Unicorn2: " + t);
            }
        } else {
            System.err.println("[native-bridge] 模拟后端: Unicorn2（-Dtvbox.native.backend=unicorn2 强制）");
        }
        return new Unicorn2Factory(true);
    }

    /**
     * ★ 2026-09-27（壳通解）：**解密 dex 的加载器登记表**。
     *
     * <p>壳的 native 会把「真实蜘蛛类」交给它自己 new 出来的 {@code DexClassLoader}
     * （= 本桥的 stub，见 stubs-src/dalvik/system/BaseDexClassLoader.java，运行时把解密产物
     * dex2jar 后挂 URLClassLoader）。随后 native 又会用 JNI 去**调用那些类的静态方法**
     * （实测 wex：`InitOrigin.init(Context)`）——而 unidbg 的反射代理按**类名**找一个 JVM 类，
     * 只会在「壳加载器」里找 → ClassNotFoundException → 整条守卫链降级。
     *
     * <p>因此：stub 建好 delegate 后把自己登记到这里，类工厂/映射器解析不到时再来这里找。
     */
    private static final List<ClassLoader> EXTRA_LOADERS = new java.util.concurrent.CopyOnWriteArrayList<ClassLoader>();

    public static void registerExtraLoader(ClassLoader loader) {
        if (loader != null && !EXTRA_LOADERS.contains(loader)) EXTRA_LOADERS.add(loader);
    }

    /** 按名字从「解密 dex 加载器」里找类（后登记的优先）；找不到返回 null */
    public static Class<?> loadExtra(String dottedName) {
        for (int i = EXTRA_LOADERS.size() - 1; i >= 0; i--) {
            try {
                return Class.forName(dottedName, false, EXTRA_LOADERS.get(i));
            } catch (Throwable ignored) {
                // 换下一个加载器
            }
        }
        return null;
    }

    /**
     * ★ 2026-09-27（壳通解）：把 jar 的 `assets/**` 装进 unidbg 的 libandroid 虚拟模块，
     * 让原生代码用 `AAssetManager_open("assets/xxx.guard")` 之类的调用能真的读到数据。
     * 名字同时按「完整条目名」和「去掉 assets/ 前缀」两种键登记（壳的写法两种都见过）。
     * 失败只降级（打日志），不影响无资产需求的壳。
     */
    private static void installAssets(File jar, String soName) {
        try {
            AndroidModule android = new AndroidModule(emulator, vm);
            android.register(emulator.getMemory());
            int n = 0;
            try (JarFile jf = new JarFile(jar)) {
                Enumeration<JarEntry> it = jf.entries();
                while (it.hasMoreElements()) {
                    JarEntry e = it.nextElement();
                    String name = e.getName();
                    if (e.isDirectory() || !name.startsWith("assets/")) continue;
                    byte[] data = readAll(jf.getInputStream(e));
                    android.addAsset(name, data);
                    String stripped = name.substring("assets/".length());
                    android.addAsset(stripped, data);
                    n++;
                }
            }
            System.err.println("[native-bridge] libandroid 资产模块就绪（" + soName + "）——装入 assets " + n + " 个");
        } catch (Throwable t) {
            System.err.println("[native-bridge] libandroid 资产模块注册失败（按无资产降级）: " + t);
        }
    }

    /**
     * 改写后的 native 方法唯一入口（壳 jar）：按描述符分发到 unidbg 的 DVM 调用（全局串行，模拟器非线程安全）。
     */
    public static Object invoke(String className, String method, String desc, Object[] args) {
        synchronized (LOCK) {
            try {
                ensureInit(); // ★ 惰性：改写产物复用时，模拟器在「第一次真的调原生」时才启动
            } catch (Exception e) {
                throw new IllegalStateException("原生桥按需初始化失败: " + e, e);
            }
            DvmClass c = CLASSES.get(className);
            if (c == null) throw new IllegalStateException("原生桥未就绪或未登记类: " + className);
            Object r = call(className, c, emulator, method, desc, args, vm);
            warnNullGuardResult(className, method, r);
            return r;
        }
    }

    /**
     * ★★ 2026-09-29（设备实证「切换部分源 NPE」）：壳的守卫链只有两步 ——
     * `DexNative.getLoader` → DexClassLoader、`DexNative.getSpider` → 真实蜘蛛实例。
     * 任一**静默返回 null**，`BaseSpiderGuard` 的字段就留空，随后第一个 `init()` 必抛
     * `NullPointerException: Cannot invoke "…Spider.init(android.content.Context, String)"`。
     * 此前这两处 null 完全没有日志（设备上只能看到下游 NPE），这里把根因显式打出来。
     */
    private static void warnNullGuardResult(String className, String method, Object r) {
        if (r != null) return;
        if ("getLoader".equals(method) || "getSpider".equals(method)) {
            System.err.println("[native-bridge] 警告: " + className + "#" + method
                    + " 返回 null —— 壳的守卫内层蜘蛛将为空（后续首个 init() 必 NPE）；"
                    + "解密 dex / 加载器链路未走通（看上面是否有保存/解密/转换失败日志）");
        }
    }

    /**
     * ★ 2026-09-27（壳通解·载荷层）：**运行时 dex 里的 native** 的唯一入口（由 NativePatcher 载荷模式生成）。
     *
     * <p>与 {@link #invoke} 的差别只有一个：类不在「壳注册表」里，而是解密 dex 的真实类 ——
     * 它的 native 由载荷 .so 提供（可能注册在 32 位模拟器，也可能是壳自己那只 64 位）。
     * 因此这里**按「谁真的提供了这个方法」路由**（注册表精确命中 → `Java_<mangled>` 导出符号），
     * 而不是按预设计划。
     */
    public static Object invokePayload(String className, String method, String desc, Object[] args) {
        // ★ 锁纪律：**一次只持有一把**（先 32 位载荷锁、释放后再考虑壳锁），绝不同时持有两把 ——
        //   否则两线程可能以相反顺序取锁 → 锁顺序死锁。见 LOCK 注释（真机死锁取证）。
        if (payloadVm != null) {
            synchronized (PAYLOAD_LOCK) {
                if (hasNative(payloadVm, payloadEmulator, className, method, desc)) {
                    Object r = call(className, payloadVm.resolveClass(className), payloadEmulator, method, desc, args, payloadVm);
                    warnNullGuardResult(className, method, r);
                    payloadTrace(className, method, r);
                    return r;
                }
            }
        }
        if (payloadInShell) {
            // 罕见：AArch64 载荷与壳共用模拟器（见 payloadLoad）
            synchronized (LOCK) {
                if (hasNative(vm, emulator, className, method, desc)) {
                    Object r = call(className, vm.resolveClass(className), emulator, method, desc, args, vm);
                    payloadTrace(className, method, r);
                    return r;
                }
            }
        }
        throw new IllegalStateException("载荷桥未就绪或未登记方法: " + className + "." + method + desc
                + "（已登记载荷库 " + payloadLibsSummary()
                + (PAYLOAD_INIT_FAILURES.containsKey(className)
                ? "；该类初始化失败: " + PAYLOAD_INIT_FAILURES.get(className) : "")
                + "）");
    }

    /** 已登记载荷库摘要（诊断用；装载表由 payloadLoad 的类锁保护，这里同步读一份快照） */
    private static synchronized String payloadLibsSummary() {
        return PAYLOAD_LIBS.toString();
    }

    /** 载荷调用诊断（-Dtvbox.native.payload.trace=1）：打印每次载荷 native 调用的返回值摘要 */
    private static void payloadTrace(String className, String method, Object r) {
        if (!"1".equals(System.getProperty("tvbox.native.payload.trace"))) return;
        String v = "null";
        if (r instanceof String) {
            String s = (String) r;
            v = "\"" + (s.length() > 60 ? s.substring(0, 60) + "…(" + s.length() + ")" : s) + "\"";
        } else if (r instanceof byte[]) {
            byte[] b = (byte[]) r;
            StringBuilder hex = new StringBuilder();
            for (int i = 0; i < Math.min(16, b.length); i++) hex.append(String.format("%02x", b[i]));
            v = "byte[" + b.length + "] " + hex;
        } else if (r != null) {
            v = String.valueOf(r);
        }
        System.err.println("[nb.payload] " + className + "." + method + " → " + v);
    }

    /** native 方法是否真有着落：① 已注册进 nativesMap（RegisterNatives）② 模块里有 Java_ 导出符号 */
    private static boolean hasNative(VM v, AndroidEmulator emu, String className, String method, String desc) {
        if (v == null || emu == null) return false;
        if (nativesMap(v.resolveClass(className)).containsKey(method + desc)) return true;
        try {
            String sym = "Java_" + mangle(className) + "_" + mangle(method);
            for (Module m : emu.getMemory().getLoadedModules()) {
                if (m.findSymbolByName(sym, false) != null) return true;
            }
        } catch (Throwable t) {
            // 诊断失败按「没有」处理
        }
        return false;
    }

    /** 统一的分发（壳与载荷共用）：描述符 → DVM 调用 → Java 值 */
    private static Object call(String className, DvmClass c, AndroidEmulator emu, String method, String desc, Object[] args, VM target) {
        String sig = method + desc;
        Object[] a = args == null || args.length == 0 ? NO_ARGS : marshal(args, target);
        char ret = desc.charAt(desc.indexOf(')') + 1);
        long t0 = PROFILE ? System.nanoTime() : 0L;
        Object r;
        switch (ret) {
            case 'V':
                c.callStaticJniMethod(emu, sig, a);
                r = null;
                break;
            case 'Z':
                r = c.callStaticJniMethodBoolean(emu, sig, a);
                break;
            case 'I':
                r = c.callStaticJniMethodInt(emu, sig, a);
                break;
            case 'S':
                r = (short) c.callStaticJniMethodInt(emu, sig, a);
                break;
            case 'B':
                r = (byte) c.callStaticJniMethodInt(emu, sig, a);
                break;
            case 'C':
                r = (char) c.callStaticJniMethodInt(emu, sig, a);
                break;
            case 'J':
                r = c.callStaticJniMethodLong(emu, sig, a);
                break;
            case 'L':
            case '[':
                r = unwrap(c.callStaticJniMethodObject(emu, sig, a), ret == '[');
                break;
            default:
                throw new UnsupportedOperationException("原生桥暂不支持返回类型: " + desc);
        }
        if (PROFILE) profileLine(className, method, desc, args, r, (System.nanoTime() - t0) / 1_000_000L);
        return r;
    }

    // ---------------- 评测仪表（-Dtvbox.native.profile=1） ----------------
    //
    // 目的（2026-09-28 FishGuard 壳性能专项，假设 H2/H4）：把「每次 native 调用的耗时 + 入参摘要 + 返回摘要」
    // 落成一行 stderr —— 离线即可统计「JNI/编组开销 vs 模拟执行开销」「入参重复率（是否值得做结果缓存）」。
    // 默认关闭（只多一行判断）；开销 = 入参 SHA-1 前 4 字节（20KB 数组约 50µs，相对单次 12~30s 可忽略）。

    private static final boolean PROFILE = "1".equals(System.getProperty("tvbox.native.profile"));

    private static void profileLine(String className, String method, String desc, Object[] args, Object r, long ms) {
        StringBuilder sb = new StringBuilder("[nb.prof] ");
        String simple = className == null ? "?" : className.substring(className.lastIndexOf('/') + 1);
        sb.append(simple).append('#').append(method).append(desc)
                .append(" arg=").append(digest(args))
                .append(" ms=").append(ms)
                .append(" ret=").append(digest(r));
        System.err.println(sb);
    }

    /** 入参/返回值摘要：byte[] / String 走长度+内容哈希（可判重复），其余原样 */
    private static String digest(Object v) {
        if (v == null) return "null";
        if (v instanceof byte[]) {
            byte[] b = (byte[]) v;
            return "b:" + b.length + ":" + sha1_8(b);
        }
        if (v instanceof String) {
            String s = (String) v;
            return "s:" + s.length() + ":" + sha1_8(s.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        }
        if (v instanceof Object[]) {
            Object[] a = (Object[]) v;
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < a.length; i++) {
                if (i > 0) sb.append(',');
                sb.append(digest(a[i]));
            }
            return sb.append(']').toString();
        }
        return String.valueOf(v);
    }

    // ---------------- 载荷库装载（System.load 的桥接版） ----------------
    //
    // 真机取证（wex 玩偶）：解密出的明文 dex 自带 ARM32 native —— `LoadNiMa`（libLoadNiMa.so）、
    // `MyCrypto`（libdecjni.so）、`GoProxy`（libwexproxy.so）。它们的 `<clinit>` 自己把 .so 拷出来
    // 再 `System.load(绝对路径)`；宿主 x64 装不了 ARM32 → UnsatisfiedLinkError → 只捕获
    // FileNotFoundException 的 `<clinit>` 直接抛 ExceptionInInitializerError → 主页全空。
    // 因此 NativePatcher 载荷模式把该调用点换成 bridgeLoad(path)：**路径绝不能丢**，
    // 它就是载荷 .so 的落盘位置（模拟器要按它装载；壳那边相反——.so 由桥自己从 jar 提取）。

    /** 载荷层诊断报告（未启用返回空串） */
    public static String payloadReport() {
        return payloadReport;
    }

    /**
     * 载荷类 `<clinit>` 的**唯一入口**（由 NativePatcher 合成的新 `<clinit>` 调用）：
     * 反射调用被改名保存的原初始化体（{@code NativePatcher.CLINIT_BODY}），异常在这里被吞成一条日志。
     * 见 NativePatcher 的注释：载荷类常因「上游没发布对应 .so」在 `<clinit>` 里炸掉整条线程。
     *
     * @param dottedClassName 点号类名（改写时写死在字节码里）
     */
    public static void clinitRun(String dottedClassName) {
        try {
            Class<?> c = loadExtra(dottedClassName);
            if (c == null) c = Class.forName(dottedClassName, false, NativeBridge.class.getClassLoader());
            java.lang.reflect.Method m = c.getDeclaredMethod("tvboxClinit");
            m.setAccessible(true);
            m.invoke(null);
        } catch (Throwable t) {
            Throwable cause = t instanceof java.lang.reflect.InvocationTargetException && t.getCause() != null
                    ? t.getCause() : t;
            clinitFailed(dottedClassName, cause);
        }
    }

    /**
     * 载荷类 `<clinit>` 的失败兜底（由 {@link #clinitRun} 调用）：
     * 缺 .so（上游没随壳发布）不该让整个后台线程带着 `ExceptionInInitializerError` 死掉 ——
     * 这里记一条带类名的中文日志，并把原因留在表里，等真正调用该 native 时报明确的失败点。
     */
    public static void clinitFailed(String className, Throwable t) {
        String msg = t == null ? "unknown" : t.toString();
        PAYLOAD_INIT_FAILURES.put(className, msg);
        System.err.println("[native-bridge] 载荷类初始化失败（已捕获，用到它的 native 时会给出明确报错）: "
                + className + " → " + msg);
    }

    /** 载荷类的 `<clinit>` 失败原因（invokePayload 的报错里会带上） */
    private static final Map<String, String> PAYLOAD_INIT_FAILURES = new java.util.concurrent.ConcurrentHashMap<>();

    /**
     * `System.load(path)` 的桥接版（只由改写产物调用）。装不上时**不抛异常** ——
     * 宿主 x64 装不了 ARM 是常态，异常会带崩 `<clinit>`；这里只大声记日志，
     * 后续 native 调用会给出更准确的失败点（invokePayload 的报错里带已登记载荷库）。
     */
    public static void bridgeLoad(String path) {
        try {
            payloadLoad(path);
        } catch (Throwable t) {
            System.err.println("[native-bridge] 载荷库装载失败（其 native 调用将不可用）: " + path + " → " + t);
        }
    }

    /**
     * 按 ELF 位宽把载荷 .so 装进对应模拟器：ARM32 → **专用 32 位模拟器**（壳那只可能是 64 位），
     * AArch64 → 与壳共用（unidbg 的 `findNativeFunction` 会扫描该模拟器里**全部**已加载模块，
     * 所以多只 .so 共用一只模拟器是设计内的用法）。
     * ★ 方法级同步：多只载荷类可能在不同线程同时 `<clinit>`（wex：LoadNiMa 与 MyCrypto 各一个线程），
     *   而 unidbg 的模拟器/VM **不是线程安全的** —— 装载必须串行（与 LOCK 无关，不会形成锁顺序问题）。
     */
    private static synchronized void payloadLoad(String path) throws Exception {
        String key = path == null ? "" : path.trim();
        if (key.isEmpty() || PAYLOAD_LIBS.containsKey(key)) return;
        // ★★ 2026-09-28（实测「订阅里两个源走满 300s 超时」根因）：**桌面必须跳过 wex 的 Go 代理库**
        //   载荷会下载并把 `libwexproxy*.so`（10MB，Android root/Go DNS 代理：`su -c chmod … -port 8096
        //   -dns :53 -sign …`）装进 32 位模拟器；它的 native 启动（`GoProxyManager.startSo native start`）
        //   在 unidbg 里**挂死**（`Invalid memory read (UC_ERR_READ_UNMAPPED)` 后不再前进），而模拟器
        //   **全局串行** ⇒ 该源后续的加解密 native 调用全部排队 ⇒ 单次调用 300s
        //   （`NATIVE_CALL_MIN_TIMEOUT_MS`）判死，用户侧就是「这个源卡 5 分钟然后空结果」。
        //   桌面既无 root 也没有 8096/53 的用途 ⇒ 直接按「不装载」跳过，让调用点快速失败并走
        //   GoProxy 自己的降级路径（与「文件不存在」时的历史行为一致 —— 那条路径实测不卡、源正常）。
        String baseName = new File(key).getName().toLowerCase();
        if (baseName.contains("wexproxy") || baseName.contains("go_proxy") || baseName.contains("goproxy")) {
            PAYLOAD_LIBS.put(key, "桌面跳过（Android root/Go 代理，见 NativeBridge.payloadLoad 注释）");
            System.err.println("[native-bridge] 载荷库跳过（桌面不适用：Android root/Go 代理）: " + key);
            return;
        }
        File src = new File(key);
        if (!src.isFile()) {
            PAYLOAD_LIBS.put(key, "文件不存在");
            System.err.println("[native-bridge] 载荷库文件不存在（跳过装载）: " + key);
            return;
        }
        byte[] data = readAll(new java.io.FileInputStream(src));
        int bits = elfBits(data);
        if (bits == 0) {
            PAYLOAD_LIBS.put(key, "非 ARM ELF");
            System.err.println("[native-bridge] 载荷库不是 ARM ELF（跳过装载）: " + key);
            return;
        }
        if (bits == 64) {
            ensureInit(); // 64 位载荷与壳共用模拟器（惰性：这里才真的要模拟器）
            File landed = landSo(new File(payloadSoDir(), src.getName()), data);
            DalvikModule dm = vm.loadLibrary(landed, true);
            dm.callJNI_OnLoad(emulator);
            payloadInShell = true;
            PAYLOAD_LIBS.put(key, landed.getName() + " (" + data.length + "B, 64 位)");
            System.err.println("[native-bridge] 载荷库已装入壳模拟器: " + landed.getName() + " (" + data.length + "B)");
            return;
        }
        ensurePayloadVm();
        File landed = landSo(new File(payloadSoDir(), src.getName()), data);
        DalvikModule dm = payloadVm.loadLibrary(landed, true);
        dm.callJNI_OnLoad(payloadEmulator);
        PAYLOAD_LIBS.put(key, landed.getName() + " (" + data.length + "B, 32 位)");
        System.err.println("[native-bridge] 载荷库已装入 32 位模拟器: " + landed.getName() + " (" + data.length + "B)");
    }

    /** 载荷 .so 的落地目录（与壳的 workDir 同根，便于一起清理） */
    private static File payloadSoDir() {
        File base = lazyWork != null ? lazyWork : new File(System.getProperty("java.io.tmpdir"), "winbox-native-payload");
        File dir = new File(base, "payload");
        // noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return dir;
    }

    /** 载荷层用的宿主加载器：优先「解密 dex 的加载器」（见 registerExtraLoader），退回壳加载器 */
    private static ClassLoader payloadResolver() {
        if (!EXTRA_LOADERS.isEmpty()) return EXTRA_LOADERS.get(EXTRA_LOADERS.size() - 1);
        return factoryLoader(lazyResolver);
    }

    /**
     * 建立**载荷专用 32 位模拟器**（只在真的捕获到 ARM32 载荷库时才建）。
     * 配置与壳模拟器同口径：sdk23 系统库、unidbg libandroid 虚拟模块、EnvJni 垫片、桥类工厂。
     */
    private static synchronized void ensurePayloadVm() throws Exception {
        if (payloadVm != null) return;
        long t0 = System.currentTimeMillis();
        File rootfs = new File(payloadSoDir().getParentFile(), "payload-rootfs");
        // noinspection ResultOfMethodCallIgnored
        rootfs.mkdirs();

        AndroidEmulatorBuilder builder = AndroidEmulatorBuilder.for32Bit();
        builder.setProcessName("com.winbox.spider.payload");
        builder.setRootDir(rootfs);
        builder.addBackendFactory(backendFactory());
        payloadEmulator = builder.build();
        payloadEmulator.getMemory().setLibraryResolver(new AndroidResolver(23));
        payloadEmulator.getSyscallHandler().setEnableThreadDispatcher(true);
        payloadVm = payloadEmulator.createDalvikVM();

        ClassLoader resolver = payloadResolver();
        EnvJni shim = new EnvJni(null);
        BridgeClassFactory factory = new BridgeClassFactory(resolver, shim);
        factory.configClassNameMapper(name -> {
            if ("java/io/File".equals(name)) return PosixFile.class; // 见 PosixFile 注释（POSIX 路径 + rootfs 落盘）
            try {
                return Class.forName(name.replace('/', '.'), false, factoryLoader(resolver));
            } catch (Throwable t) {
                // 解密 dex 里的真实类（native 回调/静态调用它们）
                return loadExtra(name.replace('/', '.'));
            }
        });
        factory.setFallbackJni(shim);
        payloadVm.setDvmClassFactory(factory);
        payloadVm.setJni(shim);
        // 载荷 native 的 Context.getClassLoader() 要返回**解密 dex 的加载器**（它能同时看到
        // 载荷类与父链上的壳类），否则原生侧 loadClass 拿不到自己的类。见 EnvJni.setHostLoader。
        EnvJni.setHostLoader(payloadVm, resolver);
        new AndroidModule(payloadEmulator, payloadVm).register(payloadEmulator.getMemory());
        payloadReport = "载荷桥（32 位）就绪，耗时 " + (System.currentTimeMillis() - t0) + "ms";
    }

    // ---------------- 参数编组：真 Java 对象送进原生（★ 2026-09-27 壳通解，勿删） ----------------
    //
    // unidbg 的 DvmObject.callJniMethod 只认 Boolean / Hashable（DvmObject、String 等）/ 数组 / 枚举 /
    // Number，其余对象会原样丢给 Module.emulateFunction → IllegalStateException("Unsupported arg: …")。
    // 而壳的 DexNative 签名要的恰恰是真 Java 对象：
    //   getLoader(Landroid/content/Context;)  ← android.app.Application（宿主上下文）
    //   getSpider(Ldalvik/system/DexClassLoader;Ljava/lang/String;) ← 上一步拿到的加载器
    // 必须先包成 DvmObject（ProxyDvmObject.createObject 走桥的类工厂，原生回调时仍反射到真实对象）。
    // 症状对照：不包 → `[Init] java.lang.reflect.InvocationTargetException` + 日志里
    // `IllegalStateException: Unsupported arg: android.app.Application@…`，随后 BaseSpiderGuard NPE。

    private static Object[] marshal(Object[] args, VM target) {
        Object[] out = new Object[args.length];
        for (int i = 0; i < args.length; i++) out[i] = marshalArg(args[i], target);
        return out;
    }

    /** 本 VM 的「真对象 → DvmObject」缓存（见 WRAPPED 注释） */
    private static Map<Object, DvmObject<?>> wrappedFor(VM target) {
        synchronized (WRAPPED_LOCK) {
            Map<Object, DvmObject<?>> m = WRAPPED.get(target);
            if (m == null) {
                m = new WeakHashMap<Object, DvmObject<?>>();
                WRAPPED.put(target, m);
            }
            return m;
        }
    }

    private static Object marshalArg(Object a, VM target) {
        if (a == null) return null;
        if (a instanceof Hashable) return a;                       // DvmObject / String：unidbg 自己认
        if (a instanceof Number || a instanceof Boolean || a instanceof Enum) return a;
        if (a.getClass().isArray()) return a;                      // byte[]/int[]…：unidbg 自己包
        Map<Object, DvmObject<?>> cache = wrappedFor(target);
        DvmObject<?> cached = cache.get(a);
        if (cached != null) return cached;
        try {
            DvmObject<?> o = ProxyDvmObject.createObject(target, a);
            cache.put(a, o);
            if ("1".equals(System.getProperty("tvbox.native.debug"))) {
                System.err.println("[nb.debug] marshal " + a.getClass().getName()
                        + " -> " + o.getClass().getName() + " objType=" + o.getObjectType().getName());
            }
            return o;
        } catch (Throwable t) {
            System.err.println("[native-bridge] 参数包装失败 " + a.getClass().getName() + ": " + t);
            return a;
        }
    }

    /** DVM 返回值 → Java 值（String / byte[] / String[] / 原始包装） */
    private static Object unwrap(DvmObject<?> o, boolean isArray) {
        if (o == null) return null;
        Object v = o.getValue();
        if (!isArray) return v;
        if (v instanceof byte[] || v instanceof short[] || v instanceof int[] || v instanceof long[]
                || v instanceof float[] || v instanceof double[] || v instanceof char[] || v instanceof boolean[]) {
            return v;
        }
        if (o instanceof ArrayObject || v instanceof DvmObject<?>[]) {
            DvmObject<?>[] arr = o instanceof ArrayObject ? ((ArrayObject) o).getValue() : (DvmObject<?>[]) v;
            if (arr == null) return null;
            Object[] out = new Object[arr.length];
            for (int i = 0; i < arr.length; i++) out[i] = arr[i] == null ? null : arr[i].getValue();
            return out;
        }
        return v;
    }

    // ---------------- 反射读 unidbg 内部表 ----------------

    @SuppressWarnings("unchecked")
    private static Map<String, ?> nativesMap(DvmClass c) {
        try {
            Field f = DvmClass.class.getDeclaredField("nativesMap");
            f.setAccessible(true);
            return (Map<String, ?>) f.get(c);
        } catch (Throwable t) {
            return java.util.Collections.emptyMap();
        }
    }

    private static int nativesCount(DvmClass c) {
        return nativesMap(c).size();
    }

    // ---------------- .so 提取 / 架构判定 ----------------

    private static File extractSo(File jar, File outDir) throws Exception {
    File best = null;
    byte[] bestData = null;
    int bestScore = -1;
    try (JarFile jf = new JarFile(jar)) {
      Enumeration<JarEntry> it = jf.entries();
      while (it.hasMoreElements()) {
        JarEntry e = it.nextElement();
        String name = e.getName();
        if (e.isDirectory() || !name.endsWith(".so")) continue;
        try (InputStream is = jf.getInputStream(e)) {
          byte[] data = readAll(is);
          int bits = elfBits(data);
          if (bits == 0) continue; // 非 ELF（可能是别的资源）
          int score = bits == 64 ? 2 : 1;
          if (score > bestScore) {
            best = new File(outDir, new File(name).getName());
            bestData = data;
            bestScore = score;
          }
        }
      }
    }
    if (best == null) throw new IllegalStateException("jar 内没有可用的 ARM .so: " + jar.getName());
    return landSo(best, bestData);
  }

  /**
     * 落地 .so —— ★ 多进程并发铁律（真机实测踩过，勿退回「无条件覆盖写」）：
     *   蜘蛛池会为**同一只 jar** 并行拉起多个常驻 JVM，它们共用同一个 workDir；而 unidbg 会把 .so
     *   **mmap 进宿主进程**，只要还有一个进程映射着它，其它进程覆盖写就会失败
     *   （Windows: `The requested operation cannot be performed on a file with a user-mapped section open`
     *   → FileNotFoundException）→ 桥整体降级，且失败方的清理还会连带删掉别的进程写好的产物。
     *   因此：① 内容一致 → **直接复用（绝不重写）**；② 内容不同 → 临时文件 + 原子替换；
     *   ③ 替换也失败（被映射）→ 退化为**内容寻址副本** `<名>.<sha1-8>.so`，不碰旧文件。
     */
    private static File landSo(File target, byte[] data) throws Exception {
    if (sameBytes(target, data)) return target;
    File tmp = new File(target.getParentFile(), target.getName() + ".tmp");
    java.nio.file.Files.write(tmp.toPath(), data);
    try {
      java.nio.file.Files.move(tmp.toPath(), target.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
      return target;
    } catch (Throwable locked) {
      String n = target.getName();
      String base = n.endsWith(".so") ? n.substring(0, n.length() - 3) : n;
      File alt = new File(target.getParentFile(), base + "." + sha1_8(data) + ".so");
      if (sameBytes(alt, data)) {
        // noinspection ResultOfMethodCallIgnored
        tmp.delete();
      } else {
        java.nio.file.Files.move(tmp.toPath(), alt.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
      }
      System.err.println("[native-bridge] 原 .so 被其它进程映射，改用内容寻址副本: " + alt.getName());
      return alt;
    }
  }

    private static boolean sameBytes(File f, byte[] data) {
    try {
      if (!f.isFile() || f.length() != data.length) return false;
      return java.util.Arrays.equals(java.nio.file.Files.readAllBytes(f.toPath()), data);
    } catch (Throwable t) {
      return false;
    }
  }

    /** 内容寻址后缀（4 字节 sha1 足以区分同一 jar 内的多枚 .so） */
    private static String sha1_8(byte[] data) {
    try {
      byte[] h = java.security.MessageDigest.getInstance("SHA-1").digest(data);
      StringBuilder sb = new StringBuilder();
      for (int i = 0; i < 4; i++) sb.append(String.format("%02x", h[i]));
      return sb.toString();
    } catch (Throwable t) {
      return Integer.toHexString(data.length);
    }
  }

    private static byte[] readAll(InputStream is) throws Exception {
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream(1 << 20);
        byte[] buf = new byte[1 << 16];
        int n;
        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
        return bos.toByteArray();
    }

    /** ELF 头判位数：0=非 ELF，32/64=位宽（仅接受 ARM 家族：0xb7 AArch64 / 0x28 ARM32） */
    private static int elfBits(byte[] d) {
        if (d.length < 20) return 0;
        if (d[0] != 0x7f || d[1] != 'E' || d[2] != 'L' || d[3] != 'F') return 0;
        int machine = (d[18] & 0xff) | ((d[19] & 0xff) << 8);
        if (d[4] == 2 && machine == 0xb7) return 64;
        if (d[4] == 1 && machine == 0x28) return 32;
        return 0;
    }

    private static int detectArchBits(File so) throws Exception {
        try (InputStream is = new java.io.FileInputStream(so)) {
            byte[] head = new byte[20];
            int n = is.read(head);
            int bits = n == 20 ? elfBits(head) : 0;
            if (bits == 0) throw new IllegalStateException(".so 架构不受支持（只支持 AArch64 / ARM32）: " + so.getName());
            return bits;
        }
    }

    // ---------------- jar 内 native 方法扫描（ASM） ----------------

    /** 类（内部名） → 该类的 native 方法 [name, desc] 列表（载荷层计划复用，见 NativePatcher.scanPayloadPlan） */
    static Map<String, List<String[]>> scanNativeMethods(File jar) throws Exception {
        Map<String, List<String[]>> out = new LinkedHashMap<>();
        try (JarFile jf = new JarFile(jar)) {
            Enumeration<JarEntry> it = jf.entries();
            while (it.hasMoreElements()) {
                JarEntry e = it.nextElement();
                if (e.isDirectory() || !e.getName().endsWith(".class")) continue;
                byte[] data;
                try (InputStream is = jf.getInputStream(e)) {
                    data = readAll(is);
                }
                try {
                    ClassReader cr = new ClassReader(data);
                    final List<String[]> found = new ArrayList<>();
                    cr.accept(new ClassVisitor(Opcodes.ASM9) {
                        @Override
                        public MethodVisitor visitMethod(int access, String name, String descriptor, String signature, String[] exceptions) {
                            if ((access & Opcodes.ACC_NATIVE) != 0) found.add(new String[]{name, descriptor});
                            return null;
                        }
                    }, ClassReader.SKIP_CODE | ClassReader.SKIP_DEBUG | ClassReader.SKIP_FRAMES);
                    if (!found.isEmpty()) out.put(cr.getClassName(), found);
                } catch (Throwable ignore) {
                    // 坏类不影响其它类
                }
            }
        }
        return out;
    }

    /** JNI 名改写（与 unidbg 的 mangleForJni 完全一致，否则找不到导出符号） */
    static String mangle(String name) {
        StringBuilder sb = new StringBuilder(name.length() + 8);
        for (char c : name.toCharArray()) {
            if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
                sb.append(c);
            } else if (c == '.' || c == '/') {
                sb.append('_');
            } else if (c == '_') {
                sb.append("_1");
            } else if (c == ';') {
                sb.append("_2");
            } else if (c == '[') {
                sb.append("_3");
            } else {
                sb.append(String.format("_0%04x", (int) c));
            }
        }
        return sb.toString();
    }
}