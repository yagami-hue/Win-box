import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.Opcodes;

import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Enumeration;
import java.util.Locale;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;
import java.util.jar.JarOutputStream;

/**
 * JarRewriter —— 用 ASM 重写 jar 内 class 的**栈映射帧**，使 dex2jar 的产物
 * 能通过 JVM 字节码校验，从而**不需要 `-noverify`**。
 *
 * 为什么需要它（第十五轮，参考 PlayHub `JarSpiderService.rewriteJarForJvm`）：
 *   dex2jar 生成的 StackMapTable 帧往往不完整/不一致，HotSpot 在 Java7+ 会抛
 *   `VerifyError: Expecting a stackmap frame at branch target N`。
 *   我们此前的做法是 spawn 时加 `-noverify` —— 能用，但代价是：
 *     ① 把**整个**字节码校验都关掉；
 *     ② JDK13+ 打弃用警告，还得在日志里过滤；
 *     ③ `-noverify` 救不了"类格式错误"类问题（如非法修饰符、操作数栈类型不一致）。
 *   正确做法是**重算帧**：ASM 的 `COMPUTE_FRAMES | COMPUTE_MAXS` 会按当前字节码
 *   重新推导栈映射帧，产物是**自洽**的，校验可以正常开着。
 *
 * 关键实现要点（都是从 PlayHub 学到的、且我们踩过坑的地方）：
 *  ① **6 组合降级**：`{SKIP_FRAMES, 0, EXPAND_FRAMES} × {复用常量池, 不复用}` 逐个试，
 *     全失败才回退原始字节 —— 保证"重写失败不会让本来能跑的 jar 变坏"。
 *  ② **安全帧计算**（`SafeFrameClassWriter`）：`COMPUTE_FRAMES` 需要解析父类/接口，
 *     而蜘蛛的类大量引用 `android.*` 等服务端没有的类型；ASM 默认实现遇到
 *     解析不到的类型会抛 `TypeNotPresentException`。这里覆写 `getCommonSuperClass`，
 *     解析不到就返回 `java/lang/Object`（保守但可用），与 PlayHub 的 `SafeFrameClassWriter` 同思路。
 *  ③ **非 class 条目原样搬运** —— `assets/**`（加固壳的 .so/.guard）、`lib/**`、
 *     `META-INF/MANIFEST.MF` 全部逐字节保留。
 *      ★ 这正是我们第十二轮踩过的坑：任何"重打包"都必须保留非 class 资源。
 *  ④ **跳过签名文件**：内容一变原签名即失效，留着只会引发校验告警/异常。
 *
 * 用法: JarRewriter <输入jar> <输出jar> [额外解析用 classpath（分号分隔）]
 */
public class JarRewriter {

    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.err.println("usage: JarRewriter <in.jar> <out.jar> [extraClasspath]");
            System.exit(2);
        }
        File in = new File(args[0]);
        File out = new File(args[1]);
        String extra = args.length > 2 ? args[2] : "";
        Path tmp = Files.createTempFile(out.getParentFile().toPath(), "rw-", ".jar");
        int total = 0, rewritten = 0, fallback = 0;
        long t0 = System.currentTimeMillis();

        try (JarFile jar = new JarFile(in);
             URLClassLoader resolveLoader = buildResolver(in, extra);
             BufferedOutputStream bos = new BufferedOutputStream(Files.newOutputStream(tmp));
             JarOutputStream jos = new JarOutputStream(bos)) {

            Enumeration<JarEntry> it = jar.entries();
            while (it.hasMoreElements()) {
                JarEntry e = it.nextElement();
                if (e.isDirectory() || isSignatureEntry(e.getName())) continue;

                JarEntry target = new JarEntry(e.getName());
                if (e.getTime() > 0) target.setTime(e.getTime());
                jos.putNextEntry(target);
                try (InputStream is = jar.getInputStream(e)) {
                    if (e.getName().endsWith(".class")) {
                        byte[] raw = is.readAllBytes();
                        byte[] fixed = rewrite(raw, resolveLoader);
                        total++;
                        if (fixed == raw) fallback++; else rewritten++;
                        jos.write(fixed);
                    } else {
                        // ★ assets/** 等非 class 资源：逐字节原样搬运
                        is.transferTo(jos);
                    }
                }
                jos.closeEntry();
            }
        } catch (Throwable t) {
            Files.deleteIfExists(tmp);
            throw t;
        }
        Files.move(tmp, out.toPath(), StandardCopyOption.REPLACE_EXISTING);
        System.out.println("rewrite done: classes=" + total
                + " rewritten=" + rewritten + " fallback=" + fallback
                + " ms=" + (System.currentTimeMillis() - t0)
                + " out=" + out.length());
    }

    /** 解析用 classpath：源 jar 自身 + 调用方给的额外路径（stubs.jar / libs） */
    private static URLClassLoader buildResolver(File jar, String extra) throws Exception {
        java.util.List<URL> urls = new java.util.ArrayList<>();
        urls.add(jar.toURI().toURL());
        for (String p : extra.split(";")) {
            if (!p.isBlank()) urls.add(new File(p).toURI().toURL());
        }
        return new URLClassLoader(urls.toArray(new URL[0]), JarRewriter.class.getClassLoader());
    }

    private static boolean isSignatureEntry(String name) {
        if (name == null) return false;
        String u = name.toUpperCase(Locale.ROOT);
        if (!u.startsWith("META-INF/")) return false;
        String f = u.substring("META-INF/".length());
        return f.endsWith(".SF") || f.endsWith(".RSA") || f.endsWith(".DSA") || f.startsWith("SIG-");
    }

    /** 6 组合降级；全部失败则原样返回（保证不把能跑的 jar 弄坏） */
    private static byte[] rewrite(byte[] raw, ClassLoader resolver) {
        int[] readerFlags = { ClassReader.SKIP_FRAMES, 0, ClassReader.EXPAND_FRAMES };
        boolean[] copies = { false, true };
        Throwable last = null;
        for (int rf : readerFlags) {
            for (boolean copy : copies) {
                try {
                    return rewriteOnce(raw, resolver, copy, rf);
                } catch (Throwable t) {
                    last = t;
                }
            }
        }
        if (last != null) {
            System.err.println("[JarRewriter] 重写失败，回退原始字节: " + last);
        }
        return raw;
    }

    private static byte[] rewriteOnce(byte[] raw, ClassLoader resolver, boolean copyPool, int readerFlag) {
        ClassReader reader = new ClassReader(raw);
        ClassWriter writer = copyPool
                ? new SafeFrameClassWriter(reader, resolver)
                : new SafeFrameClassWriter(resolver);
        reader.accept(new ClassVisitor(Opcodes.ASM9, writer) {
        }, readerFlag);
        return writer.toByteArray();
    }

    /**
     * 与 PlayHub 的 `SafeFrameClassWriter` 同思路：`COMPUTE_FRAMES` 需要解析父类，
     * 而蜘蛛类常引用服务端不存在的 `android.*`；解析不到就退化为 Object，
     * 而不是让整次重写失败。
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
            try {
                Class<?> c1 = Class.forName(type1.replace('/', '.'), false, resolver);
                Class<?> c2 = Class.forName(type2.replace('/', '.'), false, resolver);
                if (c1.isAssignableFrom(c2)) return type1;
                if (c2.isAssignableFrom(c1)) return type2;
                if (c1.isInterface() || c2.isInterface()) return "java/lang/Object";
                do {
                    c1 = c1.getSuperclass();
                } while (c1 != null && !c1.isAssignableFrom(c2));
                return c1 == null ? "java/lang/Object" : c1.getName().replace('.', '/');
            } catch (Throwable t) {
                // 解析不到（android.* / 第三方缺失）→ 保守返回 Object，保证帧计算能继续
                return "java/lang/Object";
            }
        }
    }
}
