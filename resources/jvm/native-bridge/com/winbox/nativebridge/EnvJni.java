package com.winbox.nativebridge;

import com.github.unidbg.linux.android.dvm.BaseVM;
import com.github.unidbg.linux.android.dvm.DvmClass;
import com.github.unidbg.linux.android.dvm.DvmMethod;
import com.github.unidbg.linux.android.dvm.DvmObject;
import com.github.unidbg.linux.android.dvm.Jni;
import com.github.unidbg.linux.android.dvm.JniFunction;
import com.github.unidbg.linux.android.dvm.VaList;
import com.github.unidbg.linux.android.dvm.VarArg;

import java.util.Map;

/**
 * Context 系 DvmClass 的**前置 JNI**：只截 `getFilesDir()/getCacheDir()` 一族，
 * 返回与来宾 FS 对齐的 {@link PosixFile}；其余调用原样交给内层（ProxyJni 反射代理）。
 *
 * 为什么要抢在反射之前：宿主 android stub 的 getFilesDir() 返回**宿主机 Windows 路径**，
 * 原生守卫把它交给 openat 时会被来宾 FS 拼成非法路径（见 PosixFile 注释）；
 * 而 ProxyJni 是「类级 JNI」，反射成功就不会走 vm 级兜底 —— 必须在这里拦。
 */
public class EnvJni extends JniFunction {

    /** 来宾侧私有目录（POSIX；真实落盘在 <workDir>/rootfs 下） */
    static final String GUEST_FILES = "/data/data/com.winbox/files";
    static final String GUEST_CACHE = "/data/data/com.winbox/cache";

    /** 内层 JNI（= ProxyJni 反射代理）。★ 必须把 DvmMethod/VaList 原样交给它，见文末「委托纪律」 */
    private final Jni inner;

    /**
     * ★ 2026-09-27（壳通解）：壳类所在的宿主加载器（= 载入壳 jar 的 URLClassLoader，见 SpiderRunner.setupEnv）。
     *   `Context.getClassLoader()` 要返回**它**，理由：原生守卫会拿 `context.getClassLoader()` 与
     *   `Init.classLoader()`（= 壳类自己的加载器）当同一个对象用 —— 先在一个上 GetMethodID，
     *   再在另一个上 CallObjectMethod；两者不同实例/不同类时，unidbg 查不到 jmethodID →
     *   BackendException（实测 wex：`getLoader` 在 `getResourceAsStream("assets/wexshinidie.guard")`
     *   处崩，随后守卫握手失败、BaseSpiderGuard NPE）。
     *   同一加载器还能顺带解决资产读取：壳 jar 的 `assets/**` 就在它的 URL 里，`getResourceAsStream` 可取到。
     */
    private static volatile ClassLoader hostLoader;

    /**
     * ★ 2026-09-27（载荷层）：**按 VM 分桶**的宿主加载器。
     *   壳与载荷各有一只模拟器/VM，但「Context.getClassLoader() 该返回谁」两边答案不同：
     *   壳要壳加载器（读 `assets/*.guard`），载荷要**解密 dex 的加载器**（它才能 loadClass 载荷类）。
     *   一个静态字段会让后建立的那只覆盖前者（现象：载荷 native 反射自己类时 CNFE）。
     */
    private static final Map<BaseVM, ClassLoader> HOST_BY_VM =
            java.util.Collections.synchronizedMap(new java.util.WeakHashMap<BaseVM, ClassLoader>());

    /** 默认（壳）加载器 */
    public static void setHostLoader(ClassLoader loader) {
        hostLoader = loader;
    }

    /** 指定 VM 的宿主加载器（载荷层用；unidbg 的 VM 实现（DalvikVM）就是 BaseVM） */
    public static void setHostLoader(com.github.unidbg.linux.android.dvm.VM vm, ClassLoader loader) {
        if (vm instanceof BaseVM && loader != null) HOST_BY_VM.put((BaseVM) vm, loader);
    }

    static ClassLoader hostLoaderOf(BaseVM vm) {
        ClassLoader l = vm == null ? null : HOST_BY_VM.get(vm);
        return l != null ? l : hostLoader;
    }

    /** Context.getClassLoader() 的返回值（宿主加载器；未注入则交回内层反射） */
    private static boolean isClassLoaderGetter(String sig) {
        return sig != null && sig.endsWith("getClassLoader()Ljava/lang/ClassLoader;");
    }

    private static DvmObject<?> hostLoaderObject(BaseVM vm) {
        ClassLoader l = hostLoaderOf(vm);
        if (l == null) return null;
        try {
            return com.github.unidbg.linux.android.dvm.jni.ProxyDvmObject.createObject(vm, l);
        } catch (Throwable t) {
            return null;
        }
    }

    public EnvJni(Jni next) {
        super(next);
        this.inner = next;
    }

    /** 需要挂前置 JNI 的类：
     *  ① Context 系（截 getFilesDir 一族）；
     *  ② Init / InitOrigin —— 原生守卫会 `CallStaticObjectMethod(Init.context())` 取宿主持有 Context，
     *     真实返回值在桌面环境下可能为 null（Init.init 未生效），**null 会让守卫内部 NPE**
     *     （实测：`[FishSoLoader] prepare failed: NullPointerException: null`），必须兜底。 */
    public static boolean isEnvClass(String name) {
        return isContextClass(name)
                || "com/github/catvod/spider/Init".equals(name)
                || "com/github/catvod/spider/InitOrigin".equals(name);
    }

    /** 需要挂前置 JNI 的 Context 系类（守卫通常经 Application/Context 取目录） */
    public static boolean isContextClass(String name) {
        return "android/app/Application".equals(name)
                || "android/content/ContextWrapper".equals(name)
                || "android/content/Context".equals(name)
                || "android/app/Activity".equals(name)
                || "android/app/Service".equals(name);
    }

    /** 守卫取宿主 Context 的静态入口（真值优先，null 兜底） */
    private static boolean isContextGetter(String sig) {
        return sig != null && sig.endsWith("->context()Landroid/app/Application;");
    }

    /** 伪造的 Application（类链与 android stub 对齐，使反射代理/垫片都能应答其方法） */
    private static DvmObject<?> fakeApplication(BaseVM vm) {
        DvmClass context = vm.resolveClass("android/content/Context");
        DvmClass wrapper = vm.resolveClass("android/content/ContextWrapper", context);
        DvmClass app = vm.resolveClass("android/app/Application", wrapper);
        return app.newObject("win-box-app");
    }

    private static DvmObject<?> fallbackNullContext(BaseVM vm, String sig, DvmObject<?> ret) {
        if (ret == null && isContextGetter(sig)) {
            System.err.println("[native-bridge] " + sig + " 返回 null → 兜底伪造 Application（否则守卫内部会 NPE）");
            return fakeApplication(vm);
        }
        return ret;
    }

    private static boolean isFileDirSig(String sig) {
        return sig != null
                && (sig.endsWith("getFilesDir()Ljava/io/File;")
                || sig.endsWith("getCacheDir()Ljava/io/File;")
                || sig.endsWith("getCodeCacheDir()Ljava/io/File;")
                || sig.endsWith("getNoBackupFilesDir()Ljava/io/File;")
                || sig.endsWith("getExternalFilesDir(Ljava/lang/String;)Ljava/io/File;")
                || sig.endsWith("getExternalCacheDir()Ljava/io/File;"));
    }

    private static DvmObject<?> dirObject(BaseVM vm, String sig) {
        String p = sig.contains("Cache") ? GUEST_CACHE : GUEST_FILES;
        // getCodeCacheDir() 落在缓存族（Android 上就是 cache 下的 code_cache）
        if (sig.contains("CodeCache")) p = GUEST_CACHE + "/code_cache";
        PosixFile f = new PosixFile(p);
        f.mkdirs();
        return vm.resolveClass("java/io/File").newObject(f);
    }

    @Override
    public DvmObject<?> callStaticObjectMethod(BaseVM vm, DvmClass dvmClass, String signature, VarArg varArg) {
        try {
            return fallbackNullContext(vm, signature, super.callStaticObjectMethod(vm, dvmClass, signature, varArg));
        } catch (UnsupportedOperationException e) {
            return contextGetterFallback(vm, signature, e);
        }
    }

    @Override
    public DvmObject<?> callStaticObjectMethodV(BaseVM vm, DvmClass dvmClass, String signature, VaList vaList) {
        try {
            return fallbackNullContext(vm, signature, super.callStaticObjectMethodV(vm, dvmClass, signature, vaList));
        } catch (UnsupportedOperationException e) {
            return contextGetterFallback(vm, signature, e);
        }
    }

    /**
     * ★ 内层链「答不了」时的兜底（真机实测，勿删）：jdk 侧 stub 的 `Init.context()` 在这条调用链上
     * 反射不通 → 基类直接抛 `UnsupportedOperationException`，异常会把 `JNI_OnLoad`/壳自己的
     * `register()` 整条带崩（表现成桥 `准备失败 … InvocationTargetException` → 全壳降级）。
     * 只对「取 Context 的静态入口」兜底为伪造 Application；其它未支持调用照旧抛出（不静默失败）。
     */
    private static DvmObject<?> contextGetterFallback(BaseVM vm, String signature, UnsupportedOperationException e) {
        if (isContextGetter(signature)) {
            System.err.println("[native-bridge] " + signature + " 内层不支持 → 兜底伪造 Application");
            return fakeApplication(vm);
        }
        throw e;
    }

    // ---------------- 委托纪律（★ 2026-09-27 壳通解，勿回退） ----------------
    //
    // unidbg 的 JNI 分派走 **DvmMethod 变体**（`DvmMethod.callObjectMethod(obj, varArg)` → 类级 JNI 的
    // `callObjectMethod(vm, obj, DvmMethod, VarArg)`）；而基类 JniFunction 的 DvmMethod 变体只是转成
    // **字符串签名**再走 `callObjectMethod(vm, obj, String, VarArg)`，最后落在 fallbackJni 上。
    // ★ 关键：ProxyJni 的反射实现**只在 DvmMethod/VaList 变体里**（它没有覆写字符串变体）。
    //   所以本类如果只覆写字符串变体并 `super`，未拦截的调用会一路落到空 fallback →
    //   `UnsupportedOperationException: android/app/Application->getClassLoader()Ljava/lang/ClassLoader;`
    //   （实测：wex 壳 `DexNative.getLoader` 里 `context.getClassLoader()` 直接崩掉守卫握手）。
    //   因此：**要用到的每个家族都必须覆写 DvmMethod/VaList 变体，并把 DvmMethod 原样交给 inner**。

    @Override
    public DvmObject<?> callObjectMethod(BaseVM vm, DvmObject<?> dvmObject, DvmMethod dvmMethod, VarArg varArg) {
        String sig = dvmMethod.getSignature();
        debugCall(vm, dvmObject, sig);
        if (isFileDirSig(sig)) return dirObject(vm, sig);
        if (isClassLoaderGetter(sig)) {
            DvmObject<?> r = hostLoaderObject(vm);
            if (r != null) return r;
        }
        return inner == null ? super.callObjectMethod(vm, dvmObject, dvmMethod, varArg)
                : inner.callObjectMethod(vm, dvmObject, dvmMethod, varArg);
    }

    @Override
    public DvmObject<?> callObjectMethodV(BaseVM vm, DvmObject<?> dvmObject, DvmMethod dvmMethod, VaList vaList) {
        String sig = dvmMethod.getSignature();
        debugCall(vm, dvmObject, sig);
        if (isFileDirSig(sig)) return dirObject(vm, sig);
        if (isClassLoaderGetter(sig)) {
            DvmObject<?> r = hostLoaderObject(vm);
            if (r != null) return r;
        }
        return inner == null ? super.callObjectMethodV(vm, dvmObject, dvmMethod, vaList)
                : inner.callObjectMethodV(vm, dvmObject, dvmMethod, vaList);
    }

    /** 字符串变体（罕见入口；保持拦截语义，未拦截的按基类链回落） */
    @Override
    public DvmObject<?> callObjectMethod(BaseVM vm, DvmObject<?> dvmObject, String signature, VarArg varArg) {
        debugCall(vm, dvmObject, signature);
        if (isFileDirSig(signature)) return dirObject(vm, signature);
        if (isClassLoaderGetter(signature)) {
            DvmObject<?> r = hostLoaderObject(vm);
            if (r != null) return r;
        }
        return super.callObjectMethod(vm, dvmObject, signature, varArg);
    }

    @Override
    public DvmObject<?> callObjectMethodV(BaseVM vm, DvmObject<?> dvmObject, String signature, VaList vaList) {
        debugCall(vm, dvmObject, signature);
        if (isFileDirSig(signature)) return dirObject(vm, signature);
        if (isClassLoaderGetter(signature)) {
            DvmObject<?> r = hostLoaderObject(vm);
            if (r != null) return r;
        }
        return super.callObjectMethodV(vm, dvmObject, signature, vaList);
    }

    @Override
    public DvmObject<?> callStaticObjectMethod(BaseVM vm, DvmClass dvmClass, DvmMethod dvmMethod, VarArg varArg) {
        String sig = dvmMethod.getSignature();
        try {
            DvmObject<?> r = inner == null ? super.callStaticObjectMethod(vm, dvmClass, dvmMethod, varArg)
                    : inner.callStaticObjectMethod(vm, dvmClass, dvmMethod, varArg);
            return fallbackNullContext(vm, sig, r);
        } catch (UnsupportedOperationException e) {
            return contextGetterFallback(vm, sig, e);
        }
    }

    @Override
    public DvmObject<?> callStaticObjectMethodV(BaseVM vm, DvmClass dvmClass, DvmMethod dvmMethod, VaList vaList) {
        String sig = dvmMethod.getSignature();
        try {
            DvmObject<?> r = inner == null ? super.callStaticObjectMethodV(vm, dvmClass, dvmMethod, vaList)
                    : inner.callStaticObjectMethodV(vm, dvmClass, dvmMethod, vaList);
            return fallbackNullContext(vm, sig, r);
        } catch (UnsupportedOperationException e) {
            return contextGetterFallback(vm, sig, e);
        }
    }

    @Override public void callVoidMethod(BaseVM vm, DvmObject<?> o, DvmMethod m, VarArg a) {
        if (inner == null) super.callVoidMethod(vm, o, m, a); else inner.callVoidMethod(vm, o, m, a);
    }

    @Override public void callVoidMethodV(BaseVM vm, DvmObject<?> o, DvmMethod m, VaList a) {
        if (inner == null) super.callVoidMethodV(vm, o, m, a); else inner.callVoidMethodV(vm, o, m, a);
    }

    @Override public int callIntMethod(BaseVM vm, DvmObject<?> o, DvmMethod m, VarArg a) {
        return inner == null ? super.callIntMethod(vm, o, m, a) : inner.callIntMethod(vm, o, m, a);
    }

    @Override public int callIntMethodV(BaseVM vm, DvmObject<?> o, DvmMethod m, VaList a) {
        return inner == null ? super.callIntMethodV(vm, o, m, a) : inner.callIntMethodV(vm, o, m, a);
    }

    @Override public boolean callBooleanMethod(BaseVM vm, DvmObject<?> o, DvmMethod m, VarArg a) {
        return inner == null ? super.callBooleanMethod(vm, o, m, a) : inner.callBooleanMethod(vm, o, m, a);
    }

    @Override public boolean callBooleanMethodV(BaseVM vm, DvmObject<?> o, DvmMethod m, VaList a) {
        return inner == null ? super.callBooleanMethodV(vm, o, m, a) : inner.callBooleanMethodV(vm, o, m, a);
    }

    @Override public long callLongMethod(BaseVM vm, DvmObject<?> o, DvmMethod m, VarArg a) {
        return inner == null ? super.callLongMethod(vm, o, m, a) : inner.callLongMethod(vm, o, m, a);
    }

    @Override public long callLongMethodV(BaseVM vm, DvmObject<?> o, DvmMethod m, VaList a) {
        return inner == null ? super.callLongMethodV(vm, o, m, a) : inner.callLongMethodV(vm, o, m, a);
    }

    @Override public float callFloatMethodV(BaseVM vm, DvmObject<?> o, DvmMethod m, VaList a) {
        return inner == null ? super.callFloatMethodV(vm, o, m, a) : inner.callFloatMethodV(vm, o, m, a);
    }

    @Override public double callDoubleMethod(BaseVM vm, DvmObject<?> o, DvmMethod m, VarArg a) {
        return inner == null ? super.callDoubleMethod(vm, o, m, a) : inner.callDoubleMethod(vm, o, m, a);
    }

    @Override public byte callByteMethodV(BaseVM vm, DvmObject<?> o, DvmMethod m, VaList a) {
        return inner == null ? super.callByteMethodV(vm, o, m, a) : inner.callByteMethodV(vm, o, m, a);
    }

    @Override public short callShortMethodV(BaseVM vm, DvmObject<?> o, DvmMethod m, VaList a) {
        return inner == null ? super.callShortMethodV(vm, o, m, a) : inner.callShortMethodV(vm, o, m, a);
    }

    @Override public char callCharMethodV(BaseVM vm, DvmObject<?> o, DvmMethod m, VaList a) {
        return inner == null ? super.callCharMethodV(vm, o, m, a) : inner.callCharMethodV(vm, o, m, a);
    }

    @Override public void callStaticVoidMethod(BaseVM vm, DvmClass c, DvmMethod m, VarArg a) {
        if (inner == null) super.callStaticVoidMethod(vm, c, m, a); else inner.callStaticVoidMethod(vm, c, m, a);
    }

    @Override public void callStaticVoidMethodV(BaseVM vm, DvmClass c, DvmMethod m, VaList a) {
        if (inner == null) super.callStaticVoidMethodV(vm, c, m, a); else inner.callStaticVoidMethodV(vm, c, m, a);
    }

    @Override public int callStaticIntMethod(BaseVM vm, DvmClass c, DvmMethod m, VarArg a) {
        return inner == null ? super.callStaticIntMethod(vm, c, m, a) : inner.callStaticIntMethod(vm, c, m, a);
    }

    @Override public int callStaticIntMethodV(BaseVM vm, DvmClass c, DvmMethod m, VaList a) {
        return inner == null ? super.callStaticIntMethodV(vm, c, m, a) : inner.callStaticIntMethodV(vm, c, m, a);
    }

    @Override public boolean callStaticBooleanMethod(BaseVM vm, DvmClass c, DvmMethod m, VarArg a) {
        return inner == null ? super.callStaticBooleanMethod(vm, c, m, a) : inner.callStaticBooleanMethod(vm, c, m, a);
    }

    @Override public boolean callStaticBooleanMethodV(BaseVM vm, DvmClass c, DvmMethod m, VaList a) {
        return inner == null ? super.callStaticBooleanMethodV(vm, c, m, a) : inner.callStaticBooleanMethodV(vm, c, m, a);
    }

    @Override public long callStaticLongMethod(BaseVM vm, DvmClass c, DvmMethod m, VarArg a) {
        return inner == null ? super.callStaticLongMethod(vm, c, m, a) : inner.callStaticLongMethod(vm, c, m, a);
    }

    @Override public long callStaticLongMethodV(BaseVM vm, DvmClass c, DvmMethod m, VaList a) {
        return inner == null ? super.callStaticLongMethodV(vm, c, m, a) : inner.callStaticLongMethodV(vm, c, m, a);
    }

    @Override public float callStaticFloatMethod(BaseVM vm, DvmClass c, DvmMethod m, VarArg a) {
        return inner == null ? super.callStaticFloatMethod(vm, c, m, a) : inner.callStaticFloatMethod(vm, c, m, a);
    }

    @Override public double callStaticDoubleMethod(BaseVM vm, DvmClass c, DvmMethod m, VarArg a) {
        return inner == null ? super.callStaticDoubleMethod(vm, c, m, a) : inner.callStaticDoubleMethod(vm, c, m, a);
    }

    /** 调试开关（-Dtvbox.native.debug=1）：打印原生回调的「对象类 + 真实值 + 签名」，定位空指针/类不匹配 */
    private void debugCall(BaseVM vm, DvmObject<?> dvmObject, String signature) {
        if (!"1".equals(System.getProperty("tvbox.native.debug"))) return;
        String clsImpl = "null";
        String jniImpl = "null";
        try {
            if (dvmObject != null && dvmObject.getObjectType() != null) {
                DvmClass c = dvmObject.getObjectType();
                clsImpl = c.getClass().getName();
                java.lang.reflect.Field f = DvmClass.class.getDeclaredField("jni");
                f.setAccessible(true);
                Object j = f.get(c);
                jniImpl = j == null ? "null" : j.getClass().getName();
            }
        } catch (Throwable ignore) { /* 诊断用，失败不致命 */ }
        System.err.println("[native-bridge.debug] callObjectMethod this=" + System.identityHashCode(this)
                + " next=" + System.identityHashCode(nextOf(this))
                + " objClass=" + (dvmObject == null ? "null" : dvmObject.getObjectType().getName())
                + " clsImpl=" + clsImpl + " jniImpl=" + jniImpl
                + " value=" + (dvmObject == null ? "null" : String.valueOf(dvmObject.getValue()))
                + " sig=" + signature);
    }

    /** 反射读 JniFunction.fallbackJni（诊断用；读不到返回 null） */
    static Object nextOf(Object jni) {
        try {
            java.lang.reflect.Field f = com.github.unidbg.linux.android.dvm.JniFunction.class.getDeclaredField("fallbackJni");
            f.setAccessible(true);
            return f.get(jni);
        } catch (Throwable t) {
            return null;
        }
    }
}
