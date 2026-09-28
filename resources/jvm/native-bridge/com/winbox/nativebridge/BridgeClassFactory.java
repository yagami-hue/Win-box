package com.winbox.nativebridge;

import com.github.unidbg.linux.android.dvm.BaseVM;
import com.github.unidbg.linux.android.dvm.DvmClass;
import com.github.unidbg.linux.android.dvm.Jni;
import com.github.unidbg.linux.android.dvm.JniFunction;
import com.github.unidbg.linux.android.dvm.jni.ProxyClassFactory;
import com.github.unidbg.linux.android.dvm.jni.ProxyClassLoader;
import com.github.unidbg.linux.android.dvm.jni.ProxyDvmClass;
import com.github.unidbg.linux.android.dvm.jni.ProxyDvmObjectVisitor;

/**
 * 派生 ProxyClassFactory：只对 Context 系与 Init/InitOrigin 替换「类级 JNI」为 {@link EnvJni}（前置拦截 + 转发射射），
 * 其余类完全沿用 unidbg 默认行为（真实存在于 JVM 的类走反射代理，找不到的回落 vm 级垫片）。
 */
public class BridgeClassFactory extends ProxyClassFactory {

    private final Jni fallback;
    private final ClassLoader rawLoader;
    /** 正在补类层级的类名（防 Class↔Object 递归，见 createClass 注释） */
    private static final ThreadLocal<java.util.Set<String>> FILLING =
            new ThreadLocal<java.util.Set<String>>() {
                @Override
                protected java.util.Set<String> initialValue() {
                    return new java.util.HashSet<String>();
                }
            };

    public BridgeClassFactory(ClassLoader loader, Jni fallback) {
        super(loader);
        this.rawLoader = loader == null ? BridgeClassFactory.class.getClassLoader() : loader;
        this.fallback = fallback;
    }

    @Override
    public DvmClass createClass(BaseVM vm, String className, DvmClass superClass, DvmClass[] interfaceClasses) {
        // ★★ 2026-09-27（壳通解，勿回退）：**补齐类层级**。
        //   unidbg 走 JNI `FindClass` 建类时 superClass/interfaceClasses 是 null（只有对象包装
        //   `ProxyDvmObject.getObjectType` 那条路才会带层级）。层级为 null 的后果：
        //   `GetMethodID(java/io/OutputStream.write([BII)V)` 注册在父类上的 jmethodID，在
        //   FileOutputStream 实例上按 hash 查方法时**走不到父类** → `DalvikVM64$58` 直接抛
        //   BackendException（实测 wex 壳 native 把解密数据写文件时崩，守卫握手失败）。
        //   这里按真实 JVM 类反射补链（每级用 vm.resolveClass 走缓存，Object 无父类自然终止）。
        //   ★ 重入保护（必须）：`DvmClass.<init>` 内部会 resolveClass("java/lang/Class")，
        //     而 Class 的父类是 Object、Object 的初始化又要 Class —— 不防重入就是 Class↔Object
        //     无限递归（实测 StackOverflowError → 模拟器乱序 → 后续 JNI 全崩）。
        //     规则：正在补链的类名不再发起新的补链（其层级留 null，与本修复前一致）。
        if ((superClass == null || interfaceClasses == null) && !FILLING.get().contains(className)) {
            FILLING.get().add(className);
            try {
                Class<?> jc = loadQuietly(className);
                if (jc != null) {
                    if (superClass == null && jc.getSuperclass() != null) {
                        superClass = vm.resolveClass(jc.getSuperclass().getName().replace('.', '/'));
                    }
                    if (interfaceClasses == null) {
                        Class<?>[] itfs = jc.getInterfaces();
                        DvmClass[] arr = new DvmClass[itfs.length];
                        for (int i = 0; i < itfs.length; i++) {
                            arr[i] = vm.resolveClass(itfs[i].getName().replace('.', '/'));
                        }
                        interfaceClasses = arr;
                    }
                }
            } finally {
                FILLING.get().remove(className);
            }
        }
        if (EnvJni.isEnvClass(className)) {
            return new EnvDvmClass(vm, className, superClass, interfaceClasses, this.classLoader, this.visitor, this.fallback);
        }
        DvmClass dvmClass = super.createClass(vm, className, superClass, interfaceClasses);
        if (debug() && (className.startsWith("android/") || className.contains("catvod") || className.endsWith("DexClassLoader"))) {
            System.err.println("[bc.debug] createClass " + className + " -> "
                    + (dvmClass == null ? "null" : dvmClass.getClass().getName()));
        }
        return dvmClass;
    }

    private Class<?> loadQuietly(String className) {
        String dotted = className.replace('/', '.');
        try {
            return Class.forName(dotted, false, rawLoader);
        } catch (Throwable t) {
            // ★ 解密 dex 里的真实类（native 会 JNI 调它们）：见 NativeBridge.registerExtraLoader
            try {
                return NativeBridge.loadExtra(dotted);
            } catch (Throwable ignored) {
                return null;
            }
        }
    }

    private static boolean debug() {
        return "1".equals(System.getProperty("tvbox.native.debug"));
    }

    /** 只改「类级 JNI」的 ProxyDvmClass 派生：createJni 外面套一层 EnvJni */
    private static final class EnvDvmClass extends ProxyDvmClass {

        EnvDvmClass(BaseVM vm, String className, DvmClass superClass, DvmClass[] interfaceClasses,
                    ProxyClassLoader classLoader, ProxyDvmObjectVisitor visitor, Jni fallbackJni) {
            super(vm, className, superClass, interfaceClasses, classLoader, visitor, fallbackJni);
        }

        @Override
        protected JniFunction createJni(ProxyClassLoader classLoader, ProxyDvmObjectVisitor visitor, Jni fallbackJni) {
            JniFunction inner = super.createJni(classLoader, visitor, fallbackJni);
            EnvJni outer = new EnvJni(inner);
            if (debug()) {
                System.err.println("[bc.debug] createJni " + getName()
                        + " outer=" + System.identityHashCode(outer)
                        + " inner=" + inner.getClass().getName() + "#" + System.identityHashCode(inner)
                        + " innerNext=" + System.identityHashCode(EnvJni.nextOf(inner)));
            }
            return outer;
        }
    }
}
