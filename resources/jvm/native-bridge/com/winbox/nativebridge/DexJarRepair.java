package com.winbox.nativebridge;

import org.objectweb.asm.*;

import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.zip.*;

/**
 * ★ 2026-09-27「载荷壳通解」：修 dex2jar 对 R8「去掉构造器」产物的**误译**。
 *
 * <p>实测（新订阅 `9280.kstore.vip/newwex.json` 的解密 dex → 运行时产物 `83e6fefc…r*.jar`）：
 * dex2jar 有一条规则 —— **`new-instance X` 的 X 在 dex 里没有 `<init>` 时，它把 NEW 写成
 * 「随后 `invoke-direct <init>` 的 owner」**（R8 把这种匿名/合成类的构造器链直接指到祖先）。
 * 三种形态都会致命：
 * <ol>
 *   <li>`new-instance Lb1/f; invoke-direct Lb1/g;-><init>(Class)` → `NEW g`（abstract）
 *       → `InstantiationError`（b1.g.&lt;clinit&gt; 的适配器注册）；</li>
 *   <li>`new-instance Lw3/i; invoke-direct Ljava/lang/Object;-><init>()` → `NEW java/lang/Object`
 *       但随后 `INVOKEVIRTUAL w3/o.x(...)`（w3.i 的父类）→ JVM 硬崩
 *       （EXCEPTION_ACCESS_VIOLATION，hs_err 实证）；</li>
 *   <li>`new-instance Ly0/q; invoke-direct Ljava/lang/RuntimeException;-><init>(…)` → `NEW java/lang/RuntimeException`。</li>
 * </ol>
 *
 * <p><b>对齐键（关键）：</b>dex2jar 只改 NEW 的类型、**不改随后的构造器调用**（owner+desc 一模一样），
 * 所以按「构造器签名」把 dex 的 new-instance 单元与产物里的 NEW 单元配对（不是按位置）——
 * dex2jar 还会重排 new 单元，位置对齐会错。
 *
 * <p>做法：① 单元配对（签名相同 + dex 类型是产物类型的子类）；配对不上的**整方法放弃**；
 * ② 按计划把 NEW 改成 dex 的真实类型、把 `INVOKESPECIAL <祖先>.<init>` 改到该类型；
 * ③ 该类型缺 `<init>` 时**沿继承链合成**委托构造器（逐跳调直接父类，链尾落到 dex 原本的
 * 构造器 owner）→ 产物字节码自洽（无需 `-noverify` 也能过校验）。
 *
 * <p>由 `dalvik.system.BaseDexClassLoader` 在运行时 dex→jar 转换后**反射调用**（桥不在则跳过）；
 * 也可独立跑：`java -cp "<asm.jar>;<d2j/*.jar>" com.winbox.nativebridge.DexJarRepair <dex> <jar> [javaExe] [d2jCp]`。
 * 诊断：`TVBOX_REPAIR_KEEP=1` 保留 smali 临时目录；`TVBOX_REPAIR_DEBUG=1` 打印放弃明细。
 */
public final class DexJarRepair {

    /** dex 的 new-instance 单元：类型 + 紧随的构造器调用（owner/desc，可能解析不到） */
    private static final class Unit {
        final String type;
        final String owner;
        final String desc;

        Unit(String type, String owner, String desc) {
            this.type = type;
            this.owner = owner;
            this.desc = desc;
        }
    }

    public static void main(String[] args) throws Exception {
        String javaExe = args.length > 2 ? args[2] : "java";
        String d2jCp = args.length > 3 ? args[3] : "";
        int n = repair(new File(args[0]), new File(args[1]), javaExe, d2jCp);
        System.out.println("[dexjar-repair] fixed sites = " + n);
    }

    /** @return 修好的 NEW 指令 + 合成构造器数；-1 = 前置条件不满足（未做修改） */
    public static int repair(File dex, File jar, String javaExe, String d2jCp) throws Exception {
        if (dex == null || !dex.isFile() || jar == null || !jar.isFile()) return -1;
        File smaliDir = Files.createTempDirectory("tvbox-smali-").toFile();
        try {
            if (!baksmali(dex, smaliDir, javaExe, d2jCp)) return -1;
            Map<String, List<Unit>> dexUnits = parseSmali(smaliDir);
            if (dexUnits.isEmpty()) return -1;
            return patchJar(jar, dexUnits);
        } finally {
            if (System.getenv("TVBOX_REPAIR_KEEP") == null) deleteTree(smaliDir);
        }
    }

    // ---------------------------------------------------------------- dex -> smali

    private static boolean baksmali(File dex, File outDir, String javaExe, String d2jCp) {
        if (d2jCp == null || d2jCp.trim().isEmpty()) return false;
        try {
            List<String> argv = new ArrayList<String>();
            argv.add(javaExe);
            argv.add("-cp");
            argv.add(d2jCp);
            argv.add("com.googlecode.d2j.smali.BaksmaliCmd");
            argv.add(dex.getAbsolutePath());
            argv.add("-o");
            argv.add(outDir.getAbsolutePath());
            argv.add("--force"); // 目录已存在时 d2j 会静默跳过并 exit 0（不写任何文件）
            ProcessBuilder pb = new ProcessBuilder(argv);
            pb.redirectErrorStream(true);
            Process p = pb.start();
            InputStream in = p.getInputStream();
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            int code = p.waitFor();
            if (code != 0 || !outDir.isDirectory()) {
                System.err.println("[dexjar-repair] baksmali failed code=" + code + " out=" + bos.toString("UTF-8").trim());
                return false;
            }
            return true;
        } catch (Throwable t) {
            System.err.println("[dexjar-repair] baksmali exception: " + t);
            return false;
        }
    }

    /** class#methodName+desc -> 该方法按顺序出现的 new-instance 单元（含构造器签名） */
    private static Map<String, List<Unit>> parseSmali(File root) throws IOException {
        Map<String, List<Unit>> out = new HashMap<String, List<Unit>>();
        walkSmali(root, out);
        return out;
    }

    private static void walkSmali(File f, Map<String, List<Unit>> out) throws IOException {
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) walkSmali(k, out);
            return;
        }
        if (!f.getName().endsWith(".smali")) return;
        String cls = null;
        List<Unit> cur = null;
        String pendingReg = null; // 待配对的 new-instance 寄存器
        String pendingType = null;
        for (String raw : Files.readAllLines(f.toPath())) {
            String line = raw.trim();
            if (cls == null && line.startsWith(".class ")) {
                int i = line.indexOf('L');
                int j = line.lastIndexOf(';');
                if (i >= 0 && j > i) cls = line.substring(i + 1, j);
            } else if (line.startsWith(".method ")) {
                String head = line.substring(".method ".length()).trim();
                int sp = head.lastIndexOf(' ');
                cur = new ArrayList<Unit>();
                out.put(cls + "#" + (sp >= 0 ? head.substring(sp + 1) : head), cur);
                pendingReg = null;
                pendingType = null;
            } else if (line.startsWith(".end method")) {
                if (cur != null && pendingType != null) cur.add(new Unit(pendingType, null, null));
                cur = null;
                pendingReg = null;
                pendingType = null;
            } else if (cur == null) {
                continue;
            } else if (line.startsWith("new-instance ")) {
                // new-instance v0, Lcom/x/Y;
                if (pendingType != null) cur.add(new Unit(pendingType, null, null)); // 没有构造器调用（罕见）
                int comma = line.indexOf(',');
                if (comma > 0) {
                    pendingReg = line.substring("new-instance ".length(), comma).trim();
                    int i = line.indexOf('L', comma);
                    int j = line.lastIndexOf(';');
                    pendingType = (i >= 0 && j > i) ? line.substring(i + 1, j) : null;
                } else {
                    pendingReg = null;
                    pendingType = null;
                }
            } else if (pendingType != null && line.startsWith("invoke-direct {")) {
                // invoke-direct {v0, ...}, Lowner;-><init>(...)R
                int close = line.indexOf('}');
                if (close > 0) {
                    String regs = line.substring("invoke-direct {".length(), close);
                    String first = regs.split(",")[0].trim();
                    if (first.equals(pendingReg)) {
                        int arrow = line.indexOf("->", close);
                        int i = line.indexOf('L', close);
                        int j = arrow > 0 ? arrow : -1;
                        int paren = line.indexOf('(', close);
                        if (i >= 0 && j > i) {
                            String owner = line.substring(i + 1, j);
                            if (owner.endsWith(";")) owner = owner.substring(0, owner.length() - 1);
                            String desc = paren > 0 ? line.substring(paren).trim() : null;
                            cur.add(new Unit(pendingType, owner, desc));
                            pendingType = null;
                            pendingReg = null;
                        }
                    }
                }
            }
        }
    }

    // ---------------------------------------------------------------- jar patch

    private static int patchJar(File jar, Map<String, List<Unit>> dexUnits) throws IOException {
        LinkedHashMap<String, byte[]> entries = new LinkedHashMap<String, byte[]>();
        List<String> order = new ArrayList<String>();
        try (ZipFile zf = new ZipFile(jar)) {
            Enumeration<? extends ZipEntry> it = zf.entries();
            while (it.hasMoreElements()) {
                ZipEntry e = it.nextElement();
                if (e.isDirectory()) continue;
                entries.put(e.getName(), readAll(zf.getInputStream(e)));
                order.add(e.getName());
            }
        }
        final Map<String, String> supers = new HashMap<String, String>();
        final Map<String, Set<String>> ctors = new HashMap<String, Set<String>>();
        final Set<String> abstractCls = new HashSet<String>();
        for (Map.Entry<String, byte[]> e : entries.entrySet()) {
            if (!e.getKey().endsWith(".class")) continue;
            try {
                ClassReader r = new ClassReader(e.getValue());
                supers.put(r.getClassName(), r.getSuperName());
                if ((r.getAccess() & (Opcodes.ACC_ABSTRACT | Opcodes.ACC_INTERFACE)) != 0) {
                    abstractCls.add(r.getClassName());
                }
                final Set<String> set = new LinkedHashSet<String>();
                r.accept(new ClassVisitor(Opcodes.ASM9) {
                    @Override
                    public MethodVisitor visitMethod(int a, String n, String d, String s, String[] ex) {
                        if ("<init>".equals(n)) set.add(d);
                        return null;
                    }
                }, ClassReader.SKIP_CODE | ClassReader.SKIP_DEBUG | ClassReader.SKIP_FRAMES);
                ctors.put(r.getClassName(), set);
            } catch (Throwable ignore) {
            }
        }
        final SuperLookup sl = new SuperLookup() {
            @Override
            public boolean isSuperOf(String sub, String sup) {
                String c = sub;
                for (int i = 0; i < 64 && c != null; i++) {
                    if (c.equals(sup)) return true;
                    c = supers.get(c);
                }
                return false;
            }

            @Override
            public boolean isAbstractClass(String cls) {
                return abstractCls.contains(cls);
            }
        };

        int fixedNew = 0;
        int skipped = 0;
        Map<String, Set<String>> synth = new LinkedHashMap<String, Set<String>>();
        for (String name : new ArrayList<String>(order)) {
            if (!name.endsWith(".class")) continue;
            byte[] data = entries.get(name);
            // 第一遍：收集本类各方法的 NEW 单元（类型 + 紧随的构造器调用）→ 与 dex 配对
            final Map<String, List<Unit>> jarUnits = new LinkedHashMap<String, List<Unit>>();
            final Map<String, Map<Integer, String>> plans = new LinkedHashMap<String, Map<Integer, String>>();
            boolean any = false;
            try {
                ClassReader cr = new ClassReader(data);
                final String cn = cr.getClassName();
                cr.accept(new ClassVisitor(Opcodes.ASM9) {
                    @Override
                    public MethodVisitor visitMethod(int a, String n, String d, String s, String[] ex) {
                        final List<Unit> got = new ArrayList<Unit>();
                        jarUnits.put(n + d, got);
                        return new MethodVisitor(Opcodes.ASM9) {
                            private int pending = -1;

                            @Override
                            public void visitTypeInsn(int op, String type) {
                                if (op == Opcodes.NEW) {
                                    got.add(new Unit(type, null, null));
                                    pending = got.size() - 1;
                                }
                            }

                            @Override
                            public void visitMethodInsn(int op, String own, String nm, String d2, boolean itf) {
                                if (pending >= 0 && op == Opcodes.INVOKESPECIAL && "<init>".equals(nm)) {
                                    Unit u = got.get(pending);
                                    if (u.owner == null) got.set(pending, new Unit(u.type, own, d2));
                                    pending = -1;
                                }
                            }
                        };
                    }
                }, ClassReader.SKIP_DEBUG | ClassReader.SKIP_FRAMES);
                for (Map.Entry<String, List<Unit>> e : jarUnits.entrySet()) {
                    List<Unit> want = dexUnits.get(cn + "#" + e.getKey());
                    if (want == null || want.isEmpty()) continue;
                    Map<Integer, String> plan = alignUnits(want, e.getValue(), sl);
                    if (!plan.isEmpty()) {
                        plans.put(e.getKey(), plan);
                        any = true;
                    }
                }
            } catch (Throwable t) {
                continue;
            }
            if (!any) continue;

            // 第二遍：按计划改 NEW / INVOKESPECIAL + 记录要合成的构造器
            final Map<String, Set<String>> synthFinal = synth;
            final Map<String, Set<String>> ctorsFinal = ctors;
            final Map<String, Map<Integer, String>> plansFinal = plans;
            final int[] count = new int[1];
            ClassWriter cw = new ClassWriter(0);
            try {
                ClassReader cr2 = new ClassReader(data);
                cr2.accept(new ClassVisitor(Opcodes.ASM9, cw) {
                    @Override
                    public MethodVisitor visitMethod(int access, String mname, String mdesc, String sig, String[] ex) {
                        MethodVisitor mv = super.visitMethod(access, mname, mdesc, sig, ex);
                        final Map<Integer, String> plan = plansFinal.get(mname + mdesc);
                        if (plan == null) return mv;
                        return new MethodVisitor(Opcodes.ASM9, mv) {
                            private final int[] idx = new int[1];
                            private String pending;

                            @Override
                            public void visitTypeInsn(int op, String type) {
                                if (op == Opcodes.NEW) {
                                    String repl = plan.get(idx[0]);
                                    if (repl != null) {
                                        pending = repl;
                                        type = repl;
                                        count[0]++;
                                    }
                                    idx[0]++;
                                }
                                super.visitTypeInsn(op, type);
                            }

                            @Override
                            public void visitMethodInsn(int op, String own, String nm, String d, boolean itf) {
                                if (pending != null && op == Opcodes.INVOKESPECIAL && "<init>".equals(nm)) {
                                    String sub = pending;
                                    pending = null;
                                    Set<String> set = ctorsFinal.get(sub);
                                    if (set == null || !set.contains(d)) {
                                        Set<String> s2 = synthFinal.get(sub);
                                        if (s2 == null) synthFinal.put(sub, s2 = new LinkedHashSet<String>());
                                        s2.add(d);
                                    }
                                    own = sub;
                                }
                                super.visitMethodInsn(op, own, nm, d, itf);
                            }
                        };
                    }
                }, 0);
            } catch (Throwable t) {
                continue;
            }
            entries.put(name, cw.toByteArray());
            fixedNew += count[0];
        }

        // 缺构造器 → 沿继承链合成（逐跳委托直接父类；链尾落到 dex 原本的构造器 owner）
        int fixedCtors = 0;
        for (Map.Entry<String, Set<String>> e : synth.entrySet()) {
            for (String d : e.getValue()) {
                List<String> chain = new ArrayList<String>();
                String c = e.getKey();
                String owner = null;
                for (int i = 0; i < 64 && c != null; i++) {
                    Set<String> set = ctors.get(c);
                    if (set != null && set.contains(d)) {
                        owner = c;
                        break;
                    }
                    chain.add(c);
                    c = supers.get(c);
                }
                if (owner == null) owner = "java/lang/Object";
                for (int i = chain.size() - 1; i >= 0; i--) {
                    String self = chain.get(i);
                    String target = i + 1 < chain.size() ? chain.get(i + 1) : owner;
                    if (synthesizeCtor(entries, self, d, target)) {
                        Set<String> set = ctors.get(self);
                        if (set == null) ctors.put(self, set = new LinkedHashSet<String>());
                        set.add(d);
                        fixedCtors++;
                    }
                }
            }
        }

        if (fixedNew == 0 && fixedCtors == 0) return 0;

        File tmp = new File(jar.getParentFile(), jar.getName() + ".repair.tmp");
        try (ZipOutputStream zos = new ZipOutputStream(new FileOutputStream(tmp))) {
            for (String nm : order) {
                ZipEntry z = new ZipEntry(nm);
                zos.putNextEntry(z);
                zos.write(entries.get(nm));
                zos.closeEntry();
            }
        }
        Files.move(tmp.toPath(), jar.toPath(), StandardCopyOption.REPLACE_EXISTING);
        System.err.println("[dexjar-repair] NEW 修正 " + fixedNew + " 处、合成构造器 " + fixedCtors + " 个");
        return fixedNew + fixedCtors;
    }

    /** 继承判定（用 jar 内的超类表） */
    private interface SuperLookup {
        boolean isSuperOf(String sub, String sup);

        /** jar 里该类是否 abstract/interface（这类类不可能被 new —— 出现即误译） */
        boolean isAbstractClass(String cls);
    }

    /**
     * NEW 单元配对：返回「jar NEW 下标 → 应改成的 dex 类型」（只含需改的项）。
     * 键 = 构造器签名（owner+desc，dex2jar 不改这行）→ 免疫 new 单元重排；
     * dex 类型必须是产物类型的子类（否则视为不相关，放弃该方法）。
     */
    private static Map<Integer, String> alignUnits(List<Unit> dex, List<Unit> jar, SuperLookup sl) {
        Map<Integer, String> plan = new LinkedHashMap<Integer, String>();
        boolean[] used = new boolean[dex.size()];
        boolean[] done = new boolean[jar.size()];
        // 第一轮：按「构造器签名」配对（dex2jar 不改构造器调用 → 免疫 new 单元重排；最可靠）
        for (int j = 0; j < jar.size(); j++) {
            Unit ju = jar.get(j);
            int hit = -1;
            for (int k = 0; k < dex.size(); k++) {           // ① 类型 + 签名全同
                if (used[k]) continue;
                Unit du = dex.get(k);
                if (du.type.equals(ju.type) && sigEquals(du, ju)) {
                    hit = k;
                    break;
                }
            }
            if (hit < 0) {
                for (int k = 0; k < dex.size(); k++) {       // ② 同签名 + dex 类型是产物类型的子类（误译）
                    if (used[k]) continue;
                    Unit du = dex.get(k);
                    if (sigEquals(du, ju) && sl.isSuperOf(du.type, ju.type)) {
                        hit = k;
                        break;
                    }
                }
            }
            if (hit < 0) continue;
            used[hit] = true;
            done[j] = true;
            Unit du = dex.get(hit);
            if (!du.type.equals(ju.type)) plan.put(j, du.type);
        }
        // 第二轮：产物 NEW 落到 Object/抽象类（必然误译，签名也对不上时）→ 取下一个未用 dex 子类
        for (int j = 0; j < jar.size(); j++) {
            if (done[j]) continue;
            Unit ju = jar.get(j);
            if (!(ju.type.equals("java/lang/Object") || sl.isAbstractClass(ju.type))) continue;
            for (int k = 0; k < dex.size(); k++) {
                if (used[k]) continue;
                Unit du = dex.get(k);
                if (sl.isSuperOf(du.type, ju.type)) {
                    used[k] = true;
                    done[j] = true;
                    plan.put(j, du.type);
                    break;
                }
            }
        }
        return plan;
    }

    private static boolean sigEquals(Unit a, Unit b) {
        return a.owner != null && b.owner != null && a.owner.equals(b.owner)
                && a.desc != null && a.desc.equals(b.desc);
    }

    private static String dump(List<Unit> l) {
        StringBuilder sb = new StringBuilder("[");
        for (Unit u : l) {
            if (sb.length() > 1) sb.append(", ");
            sb.append(u.type).append('(').append(u.owner).append(')');
        }
        return sb.append(']').toString();
    }

    /** 在 cls 里合成 `<init>(desc)`：`aload_0; <args>; invokespecial target.<init>(desc); return` */
    private static boolean synthesizeCtor(Map<String, byte[]> entries, String cls, String desc, String target) {
        byte[] data = entries.get(cls + ".class");
        if (data == null) return false;
        try {
            ClassReader r2 = new ClassReader(data);
            ClassWriter w2 = new ClassWriter(0);
            final String dd = desc;
            final String tt = target;
            r2.accept(new ClassVisitor(Opcodes.ASM9, w2) {
                @Override
                public void visitEnd() {
                    MethodVisitor mv = cv.visitMethod(Opcodes.ACC_PUBLIC, "<init>", dd, null, null);
                    mv.visitCode();
                    mv.visitVarInsn(Opcodes.ALOAD, 0);
                    Type[] at = Type.getArgumentTypes(dd);
                    int slot = 1;
                    for (Type t : at) {
                        mv.visitVarInsn(t.getOpcode(Opcodes.ILOAD), slot);
                        slot += t.getSize();
                    }
                    mv.visitMethodInsn(Opcodes.INVOKESPECIAL, tt, "<init>", dd, false);
                    mv.visitInsn(Opcodes.RETURN);
                    mv.visitMaxs(slot, slot);
                    mv.visitEnd();
                    super.visitEnd();
                }
            }, 0);
            entries.put(cls + ".class", w2.toByteArray());
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    private static byte[] readAll(InputStream in) throws IOException {
        try {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return bos.toByteArray();
        } finally {
            in.close();
        }
    }

    private static void deleteTree(File f) {
        try {
            if (f.isDirectory()) {
                File[] kids = f.listFiles();
                if (kids != null) for (File k : kids) deleteTree(k);
            }
            // noinspection ResultOfMethodCallIgnored
            f.delete();
        } catch (Throwable ignore) {
        }
    }
}