package com.winbox.nativebridge;

import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;
import org.objectweb.asm.Type;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.Enumeration;
import java.util.List;
import java.util.Map;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;

/**
 * 用 ASM 把 jar 里「声明为 native 的方法」改写为具体实现：
 *  - 转发型：`return (T) NativeBridge.invoke("类", "方法", "描述符", new Object[]{...});`
 *  - 空实现型（如注册入口 `register()V`，桥在初始化时已代替 Java 侧调用过）：直接 return。
 *
 * 为什么是「就地改写」而不是另写影子类（与既有 shell-shim 方案的区别）：
 *  shadow 会整体替换该类，连带丢掉它的**非 native 代码**（`load()/<clinit>/字段`）；
 *  就地改写只动 native 方法，其余字节码逐条保留，因此对任何壳都通用。
 *
 * 安全性（对齐 JarRewriter 的既有经验）：
 *  ① 单类改写失败 → **不写产物**，该类仍从原 jar 加载（保持"不改坏"）；
 *  ② 6 组合降级（{SKIP_FRAMES,0,EXPAND} × {复用常量池,不复用}）+ SafeFrameClassWriter
 *     （解析不到的父类退化为 Object，蜘蛛类大量引用 android.* 是常态）；
 *  ③ 只写被改写的类到输出目录，其余类运行时仍由原 jar 提供。
 */
public final class NativePatcher {

    /** 改写产物里 InvokeStatic 的目标（改了包名/类名要同步这里） */
    private static final String BRIDGE = "com/winbox/nativebridge/NativeBridge";
    private static final String INVOKE_DESC =
            "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;[Ljava/lang/Object;)Ljava/lang/Object;";
    /** 载荷层入口（解密 dex 里的 native → 32 位模拟器）；与 INVOKE_DESC 同形 */
    private static final String INVOKE_PAYLOAD = "invokePayload";

    private NativePatcher() {
    }

    /**
     * @param jar      源 jar（转换产物）
     * @param outDir   改写产物目录（会被清空重建；调用方需把它排在 classpath 最前）
     * @param plan     类（内部名）→ (方法名+描述符 → true=空实现)
     * @param resolver 解析用类加载器（stubs + 蜘蛛 jar，用于帧计算）
     * @return **实际改写**的方法数（按类里真实命中的 native 方法计，不是计划条数）
     */
    public static int patch(File jar, File outDir, Map<String, Map<String, Boolean>> plan, ClassLoader resolver) throws Exception {
        return patchJar(jar, outDir, plan, resolver, false, null);
    }

    /**
     * ★ 2026-09-27（壳通解·载荷层）：给「运行时 dex 产物」打补丁 —— 与壳jar的区别：
     *   ① 计划不是预先算好的（载荷 .so 还没被 System.load 载入，native 表无从查），
     *      因此**全量改写**：凡声明为 native 的方法一律转发到 {@code NativeBridge.invokePayload}，
     *      由载荷桥在 32 位模拟器里按「RegisterNatives 表 → Java_ 导出符号」两级解析（unidbg 内建）；
     *   ② `System.load/...` 不再「视为已加载」丢弃参数，而是转成 {@code NativeBridge.bridgeLoad(path)}
     *      —— 路径必须留下来，那正是载荷 .so 的落盘位置（模拟器要按它装载）。
     *
     * @return **写出的类数**（0 = 该 jar 不需要载荷补丁：既无 native 也无库加载调用）
     */
    public static int patchPayload(File jar, File outDir, ClassLoader resolver) throws Exception {
        int[] written = new int[1];
        patchJar(jar, outDir, scanPayloadPlan(jar), resolver, true, written);
        return written[0];
    }

    /** 载荷计划：① 全部 native 方法（转发）② 只调 System/Runtime.load* 的类（空方法表，只为钩子） */
    private static Map<String, Map<String, Boolean>> scanPayloadPlan(File jar) throws Exception {
        Map<String, Map<String, Boolean>> plan = new java.util.LinkedHashMap<>();
        for (Map.Entry<String, List<String[]>> e : NativeBridge.scanNativeMethods(jar).entrySet()) {
            Map<String, Boolean> methods = new java.util.LinkedHashMap<>();
            for (String[] m : e.getValue()) methods.put(m[0] + m[1], false);
            plan.put(e.getKey(), methods);
        }
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
                    final String[] name = new String[1];
                    final boolean[] hasLoad = new boolean[1];
                    new ClassReader(data).accept(new ClassVisitor(Opcodes.ASM9) {
                        @Override
                        public void visit(int version, int access, String n, String sig, String sup, String[] itfs) {
                            name[0] = n;
                        }

                        @Override
                        public MethodVisitor visitMethod(int access, String n, String d, String sig, String[] ex) {
                            return new MethodVisitor(Opcodes.ASM9) {
                                @Override
                                public void visitMethodInsn(int op, String own, String nm, String ds, boolean itf) {
                                    if (isLibLoad(own, nm)) hasLoad[0] = true;
                                }
                            };
                        }
                    }, ClassReader.SKIP_DEBUG | ClassReader.SKIP_FRAMES);
                    if (hasLoad[0] && name[0] != null && !plan.containsKey(name[0])) {
                        plan.put(name[0], new java.util.LinkedHashMap<String, Boolean>());
                    }
                } catch (Throwable ignore) {
                    // 坏类不影响其它类
                }
            }
        }
        return plan;
    }

    private static int patchJar(File jar, File outDir, Map<String, Map<String, Boolean>> plan,
                                ClassLoader resolver, boolean hookLoads, int[] writtenOut) throws Exception {
        int patched = 0;
        skipped = 0;
        try (JarFile jf = new JarFile(jar)) {
            Enumeration<JarEntry> it = jf.entries();
            while (it.hasMoreElements()) {
                JarEntry e = it.nextElement();
                if (e.isDirectory() || !e.getName().endsWith(".class")) continue;
                byte[] data;
                try (InputStream is = jf.getInputStream(e)) {
                    data = readAll(is);
                }
                String internalName;
                try {
                    internalName = new ClassReader(data).getClassName();
                } catch (Throwable t) {
                    continue;
                }
                Map<String, Boolean> methods = plan.get(internalName);
                // ★ 只跳过「不在计划里」的类：空表 = 只做库加载钩子（载荷层）
                if (methods == null) continue;
                int[] done = new int[1];
                byte[] out = patchClass(data, methods, resolver, done, hookLoads);
                if (out == null) continue;
                File dest = new File(outDir, internalName + ".class");
                File parent = dest.getParentFile();
                if (parent != null) parent.mkdirs();
                try (FileOutputStream fos = new FileOutputStream(dest)) {
                    fos.write(out);
                }
                patched += done[0];
                if (writtenOut != null) writtenOut[0]++;
            }
        }
        return patched;
    }

    private static byte[] patchClass(byte[] raw, Map<String, Boolean> methods, ClassLoader resolver, int[] done,
                                     boolean hookLoads) {
        int[] readerFlags = {ClassReader.SKIP_FRAMES, 0, ClassReader.EXPAND_FRAMES};
        boolean[] copies = {true, false};
        Throwable last = null;
        for (int rf : readerFlags) {
            for (boolean copy : copies) {
                try {
                    return patchOnce(raw, methods, resolver, copy, rf, done, hookLoads);
                } catch (Throwable t) {
                    last = t;
                }
            }
        }
        System.err.println("[native-bridge] 类改写失败（保留原类）: " + (last == null ? "unknown" : last.toString()));
        return null;
    }

    private static byte[] patchOnce(byte[] raw, Map<String, Boolean> methods, ClassLoader resolver,
                                    boolean copyPool, int readerFlag, int[] done, boolean hookLoads) {
        final int[] hit = new int[1];
        final int[] skippedLoads = new int[1];
        ClassReader reader = new ClassReader(raw);
        ClassWriter writer = copyPool ? new SafeFrameClassWriter(reader, resolver) : new SafeFrameClassWriter(resolver);
        reader.accept(new ClassVisitor(Opcodes.ASM9, writer) {
            private String owner;
            private final boolean[] clinitRenamed = new boolean[1];

            @Override
            public void visit(int version, int access, String name, String signature, String superName, String[] interfaces) {
                this.owner = name;
                super.visit(version, access, name, signature, superName, interfaces);
            }

            /** 合成的受保护 `<clinit>`：只调用 NativeBridge.clinitRun(owner)（异常在 Java 侧被吞掉并记日志） */
            @Override
            public void visitEnd() {
                if (clinitRenamed[0]) {
                    MethodVisitor mv = super.visitMethod(Opcodes.ACC_STATIC, "<clinit>", "()V", null, null);
                    mv.visitCode();
                    // ★ 必须传**点号**类名（owner 是内部名带 `/`）：clinitRun 内部走 Class.forName
                    mv.visitLdcInsn(owner.replace('/', '.'));
                    mv.visitMethodInsn(Opcodes.INVOKESTATIC, BRIDGE, "clinitRun", "(Ljava/lang/String;)V", false);
                    mv.visitInsn(Opcodes.RETURN);
                    mv.visitMaxs(0, 0);
                    mv.visitEnd();
                }
                super.visitEnd();
            }

            @Override
            public MethodVisitor visitMethod(int access, String name, String descriptor, String signature, String[] exceptions) {
                final Boolean noop = methods.get(name + descriptor);
                // ★★ 非目标方法必须**转交 writer**：ASM 里 visitMethod 返回 null 表示
                //    「本访问者不关心该方法」，ClassReader 会整段跳过 → 改写后的类会丢掉
                //    构造器 / <clinit> / 全部真实方法（实测：改写后 getMethod("plain") 直接
                //    NoSuchMethodException）。必须 super.visitMethod(...) 才会逐条复制。
                //    ★ 但即使是非目标方法，也要经过「库加载中性化」过滤器（见下）。
                if (noop == null) {
                    // ★★ 载荷模式：把 <clinit> 改名为 tvboxClinit，并在类尾合成一个新的 <clinit>
                    //    经 NativeBridge.clinitRun(...) 反射调用它 —— 失败在 **Java 侧**被捕获成一条
                    //    中文日志（见 ClinitGuard 注释：缺库不该炸掉整条线程）。
                    boolean clinit = hookLoads && "<clinit>".equals(name) && "()V".equals(descriptor);
                    if (clinit) clinitRenamed[0] = true;
                    return neutralize(super.visitMethod(access, clinit ? CLINIT_BODY : name, descriptor, signature, exceptions),
                            skippedLoads, hookLoads);
                }
                if ((access & Opcodes.ACC_STATIC) == 0) {
                    throw new IllegalStateException("只改写静态 native 方法: " + owner + "." + name + descriptor);
                }
                hit[0]++;
                final MethodVisitor sink = super.visitMethod(access & ~Opcodes.ACC_NATIVE, name, descriptor, signature, exceptions);
                // 用「全空 MethodVisitor」吞掉原方法体，等 visitEnd 时再发射新实现
                return new MethodVisitor(Opcodes.ASM9) {
                    @Override
                    public void visitEnd() {
                        emitBody(sink, owner, name, descriptor, noop, hookLoads ? INVOKE_PAYLOAD : "invoke");
                        sink.visitEnd();
                    }
                };
            }
        }, readerFlag);
        byte[] result = writer.toByteArray();
        done[0] = hit[0]; // 仅在本次改写成功后回填，失败重试不会重复计数
        if (skippedLoads[0] > 0) {
            skipped++;
            System.err.println("[native-bridge] 已处理 " + skippedLoads[0] + " 处库加载调用（System/Runtime.load*） —— "
                    + (hookLoads ? "已转交 NativeBridge.bridgeLoad（载荷 .so → 模拟器）"
                    : "原生实现由 unidbg 桥提供，宿主不需要也不应该 System.load ARM .so"));
        }
        return result;
    }

    /** 本次 patch 里被中性化的类数（报告用） */
    static int skipped;

    /**
     * ★★ 库加载中性化（2026-09-26 真机取证后新增，勿删）：
     *   壳 jar 的 `FishNative.loadAndRegister(path)` = `load(path)`（内部 `System.load(path)`）→ `register()`。
     *   `register()` 是 native、**已由本桥实现**；唯独 `System.load` 在 x64 上必然抛
     *   `UnsatisfiedLinkError`（ARM .so 无法被宿主加载）→ 整条加密路径被判定不可用
     *   （现象：App88/听风/木鱼等源 `bridge request encryption failed` / 详情全空）。
     *   因此：**被改写的类里，凡 `System.load/loadLibrary`、`Runtime.load/loadLibrary` 调用一律视为已加载**
     *   （弹出参数、继续执行）。只动这些调用点，其余字节码逐条保留。
     *
     * ★★ 2026-09-27（壳通解·载荷层）：`hookLoads=true` 时改口径 —— **壳 jar 与运行时 dex 不是一回事**：
     *   壳的 .so 由桥自己从 jar 里提取装载（调用点确实该丢），但**解密 dex 里的 native 库**是
     *   `<clinit>` 自己 copy 出来再 `System.load(绝对路径)` 的，路径只有在调用点才拿得到；
     *   丢掉它 = 32 位模拟器永远不知道要装哪个 .so（现象：wex 玩偶 `ExceptionInInitializerError`）。
     *   所以载荷层把 `System.load(String)` 换成 `NativeBridge.bridgeLoad(path)`（记录 + 装载）；
     *   `Runtime.load(String)` 用 SWAP+POP 去掉接收者后同样转成 bridgeLoad；其余形态照旧弹出。
     */
    private static MethodVisitor neutralize(MethodVisitor mv, int[] counter, boolean hookLoads) {
        if (mv == null) return null;
        return new MethodVisitor(Opcodes.ASM9, mv) {
            @Override
            public void visitMethodInsn(int opcode, String owner, String name, String desc, boolean itf) {
                if (isLibLoad(owner, name)) {
                    // ★ 只钩 `load(String)`（路径）；`loadLibrary(String)` 传的是库名，取不到文件 → 照旧弹出
                    if (hookLoads && "load".equals(name) && "(Ljava/lang/String;)V".equals(desc)) {
                        if (opcode == Opcodes.INVOKESTATIC) { // System.load(path)
                            mv.visitMethodInsn(Opcodes.INVOKESTATIC, BRIDGE, "bridgeLoad", "(Ljava/lang/String;)V", false);
                            counter[0]++;
                            return;
                        }
                        if (opcode == Opcodes.INVOKEVIRTUAL) { // Runtime.load(path)：栈 [recv, path] → [path]
                            mv.visitInsn(Opcodes.SWAP);
                            mv.visitInsn(Opcodes.POP);
                            mv.visitMethodInsn(Opcodes.INVOKESTATIC, BRIDGE, "bridgeLoad", "(Ljava/lang/String;)V", false);
                            counter[0]++;
                            return;
                        }
                    }
                    Type[] args = Type.getArgumentTypes(desc);
                    boolean wide = false;
                    for (Type t : args) {
                        if (t.getSize() == 2) wide = true;
                    }
                    if (!wide) {
                        for (Type t : args) {
                            mv.visitInsn(t.getSize() == 2 ? Opcodes.POP2 : Opcodes.POP);
                        }
                        if (opcode != Opcodes.INVOKESTATIC) mv.visitInsn(Opcodes.POP); // 接收者
                        counter[0]++;
                        return;
                    }
                }
                super.visitMethodInsn(opcode, owner, name, desc, itf);
            }
        };
    }

    /**
     * ★★ 2026-09-27（载荷层补完）：**把载荷类 `<clinit>` 的失败从「JVM 级异常」降级为「可读日志 + 首次调用报错」**。
     *
     * <p>为什么必须这么做（真机取证）：载荷类的 `<clinit>` 普遍是「把 .so 拷到临时名 → `System.load`」，
     * 而这些 .so 有的**上游根本没随壳发布**（实测 wex：`GoProxy` 要的 `libwexproxy.so` 不在任何 jar /
     * 沙箱里，全库也无下载 URL）。原样跑 → `FileNotFoundException` → `ExceptionInInitializerError`
     * 把整个后台线程打死并刷一屏堆栈，且该类被 JVM 标记为 erroneous（后续引用都变成 `NoClassDefFoundError`，
     * 指向完全无关的地方）。
     *
     * <p>做法：把原 `<clinit>` **改名**为 {@link #CLINIT_BODY}，再合成一个新的 `<clinit>` 调
     * {@code NativeBridge.clinitRun} —— try/catch 落在**桥的 Java 代码里**（不用 ASM 的异常处理器：
     * 实测手写 try/catch 会让 ClassWriter 的 COMPUTE_FRAMES 内部 NPE，形状对不齐）。
     * 于是：类初始化照常完成，缺库由 {@code clinitFailed} 记一条中文日志，真正用到该 native 时
     * 再由 `invokePayload` 报明确错误 —— 失败点前移到调用点，既不失联也不静默。
     */
    static final String CLINIT_BODY = "tvboxClinit";

    private static boolean isLibLoad(String owner, String name) {
        if ("java/lang/System".equals(owner)) return "load".equals(name) || "loadLibrary".equals(name);
        if ("java/lang/Runtime".equals(owner)) return "load".equals(name) || "loadLibrary".equals(name) || "loadLibrary0".equals(name);
        return false;
    }

    private static void emitBody(MethodVisitor mv, String owner, String name, String desc, boolean noop, String bridgeMethod) {
        mv.visitCode();
        if (noop && "()V".equals(desc)) {
            mv.visitInsn(Opcodes.RETURN);
            mv.visitMaxs(0, 0);
            return;
        }
        // ★★ 参数顺序必须与 invoke 的描述符一致：owner, name, desc, args
        //    （INVOKE_DESC = (String;String;String;[Object)Object）。把数组压在最后 ——
        //    早期版本先压数组再压三个字符串，栈上是 [Object,String,String,String]，
        //    与描述符不匹配 → 改写后的类一加载就 VerifyError（实测：Bad type on operand stack）。
        mv.visitLdcInsn(owner);
        mv.visitLdcInsn(name);
        mv.visitLdcInsn(desc);
        Type[] args = Type.getArgumentTypes(desc);
        pushInt(mv, args.length);
        mv.visitTypeInsn(Opcodes.ANEWARRAY, "java/lang/Object");
        int slot = 0;
        for (int i = 0; i < args.length; i++) {
            Type t = args[i];
            mv.visitInsn(Opcodes.DUP);
            pushInt(mv, i);
            mv.visitVarInsn(t.getOpcode(Opcodes.ILOAD), slot);
            box(mv, t);
            mv.visitInsn(Opcodes.AASTORE);
            slot += t.getSize();
        }
        mv.visitMethodInsn(Opcodes.INVOKESTATIC, BRIDGE, bridgeMethod, INVOKE_DESC, false);
        unboxAndReturn(mv, Type.getReturnType(desc));
        mv.visitMaxs(0, 0);
    }

    private static void pushInt(MethodVisitor mv, int v) {
        if (v >= -1 && v <= 5) mv.visitInsn(Opcodes.ICONST_0 + v);
        else if (v <= Byte.MAX_VALUE) mv.visitIntInsn(Opcodes.BIPUSH, v);
        else if (v <= Short.MAX_VALUE) mv.visitIntInsn(Opcodes.SIPUSH, v);
        else mv.visitLdcInsn(v);
    }

    private static void box(MethodVisitor mv, Type t) {
        switch (t.getSort()) {
            case Type.BOOLEAN:
                mv.visitMethodInsn(Opcodes.INVOKESTATIC, "java/lang/Boolean", "valueOf", "(Z)Ljava/lang/Boolean;", false);
                break;
            case Type.BYTE:
                mv.visitMethodInsn(Opcodes.INVOKESTATIC, "java/lang/Byte", "valueOf", "(B)Ljava/lang/Byte;", false);
                break;
            case Type.CHAR:
                mv.visitMethodInsn(Opcodes.INVOKESTATIC, "java/lang/Character", "valueOf", "(C)Ljava/lang/Character;", false);
                break;
            case Type.SHORT:
                mv.visitMethodInsn(Opcodes.INVOKESTATIC, "java/lang/Short", "valueOf", "(S)Ljava/lang/Short;", false);
                break;
            case Type.INT:
                mv.visitMethodInsn(Opcodes.INVOKESTATIC, "java/lang/Integer", "valueOf", "(I)Ljava/lang/Integer;", false);
                break;
            case Type.LONG:
                mv.visitMethodInsn(Opcodes.INVOKESTATIC, "java/lang/Long", "valueOf", "(J)Ljava/lang/Long;", false);
                break;
            case Type.FLOAT:
                mv.visitMethodInsn(Opcodes.INVOKESTATIC, "java/lang/Float", "valueOf", "(F)Ljava/lang/Float;", false);
                break;
            case Type.DOUBLE:
                mv.visitMethodInsn(Opcodes.INVOKESTATIC, "java/lang/Double", "valueOf", "(D)Ljava/lang/Double;", false);
                break;
            default:
                break; // 引用类型原样放进数组
        }
    }

    private static void unboxAndReturn(MethodVisitor mv, Type ret) {
        switch (ret.getSort()) {
            case Type.VOID:
                mv.visitInsn(Opcodes.POP);
                mv.visitInsn(Opcodes.RETURN);
                break;
            case Type.BOOLEAN:
                cast(mv, "java/lang/Boolean");
                mv.visitMethodInsn(Opcodes.INVOKEVIRTUAL, "java/lang/Boolean", "booleanValue", "()Z", false);
                mv.visitInsn(Opcodes.IRETURN);
                break;
            case Type.BYTE:
                cast(mv, "java/lang/Byte");
                mv.visitMethodInsn(Opcodes.INVOKEVIRTUAL, "java/lang/Byte", "byteValue", "()B", false);
                mv.visitInsn(Opcodes.IRETURN);
                break;
            case Type.CHAR:
                cast(mv, "java/lang/Character");
                mv.visitMethodInsn(Opcodes.INVOKEVIRTUAL, "java/lang/Character", "charValue", "()C", false);
                mv.visitInsn(Opcodes.IRETURN);
                break;
            case Type.SHORT:
                cast(mv, "java/lang/Short");
                mv.visitMethodInsn(Opcodes.INVOKEVIRTUAL, "java/lang/Short", "shortValue", "()S", false);
                mv.visitInsn(Opcodes.IRETURN);
                break;
            case Type.INT:
                cast(mv, "java/lang/Integer");
                mv.visitMethodInsn(Opcodes.INVOKEVIRTUAL, "java/lang/Integer", "intValue", "()I", false);
                mv.visitInsn(Opcodes.IRETURN);
                break;
            case Type.LONG:
                cast(mv, "java/lang/Long");
                mv.visitMethodInsn(Opcodes.INVOKEVIRTUAL, "java/lang/Long", "longValue", "()J", false);
                mv.visitInsn(Opcodes.LRETURN);
                break;
            case Type.FLOAT:
                cast(mv, "java/lang/Float");
                mv.visitMethodInsn(Opcodes.INVOKEVIRTUAL, "java/lang/Float", "floatValue", "()F", false);
                mv.visitInsn(Opcodes.FRETURN);
                break;
            case Type.DOUBLE:
                cast(mv, "java/lang/Double");
                mv.visitMethodInsn(Opcodes.INVOKEVIRTUAL, "java/lang/Double", "doubleValue", "()D", false);
                mv.visitInsn(Opcodes.DRETURN);
                break;
            default:
                mv.visitTypeInsn(Opcodes.CHECKCAST, ret.getInternalName());
                mv.visitInsn(Opcodes.ARETURN);
                break;
        }
    }

    private static void cast(MethodVisitor mv, String internalName) {
        mv.visitTypeInsn(Opcodes.CHECKCAST, internalName);
    }

    private static byte[] readAll(InputStream is) throws Exception {
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream(1 << 18);
        byte[] buf = new byte[1 << 16];
        int n;
        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
        return bos.toByteArray();
    }

    /**
     * 与 jvm/tools/JarRewriter 的 SafeFrameClassWriter 同思路：COMPUTE_FRAMES 需要解析父类，
     * 而蜘蛛类常引用服务端不存在的 android.*；解析不到就退化为 Object，而不是让整次改写失败。
     */
    static class SafeFrameClassWriter extends ClassWriter {
        private final ClassLoader resolver;

        SafeFrameClassWriter(ClassLoader resolver) {
            super(ClassWriter.COMPUTE_FRAMES | ClassWriter.COMPUTE_MAXS);
            this.resolver = resolver;
        }

        SafeFrameClassWriter(ClassReader reader, ClassLoader resolver) {
            super(reader, ClassWriter.COMPUTE_FRAMES | ClassWriter.COMPUTE_MAXS);
            this.resolver = resolver;
        }

        @Override
        protected String getCommonSuperClass(String type1, String type2) {
            if (type1 == null || type2 == null) return "java/lang/Object";
            if (type1.equals(type2)) return type1;
            ClassLoader cl = resolver == null ? getClass().getClassLoader() : resolver;
            try {
                Class<?> c1 = Class.forName(type1.replace('/', '.'), false, cl);
                Class<?> c2 = Class.forName(type2.replace('/', '.'), false, cl);
                if (c1.isAssignableFrom(c2)) return type1;
                if (c2.isAssignableFrom(c1)) return type2;
                if (c1.isInterface() || c2.isInterface()) return "java/lang/Object";
                do {
                    c1 = c1.getSuperclass();
                } while (c1 != null && !c1.isAssignableFrom(c2));
                return c1 == null ? "java/lang/Object" : c1.getName().replace('.', '/');
            } catch (Throwable t) {
                return "java/lang/Object";
            }
        }
    }
}
