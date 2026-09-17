package dalvik.system;

import java.io.File;

/**
 * DexClassLoader stub —— 安卓从 dex/jar/apk 动态加载类的加载器。
 *
 * <p>继承链与安卓一致：{@code DexClassLoader extends BaseDexClassLoader extends ClassLoader}，
 * 这样加固代码里的 {@code check-cast ..., Ldalvik/system/DexClassLoader;} 与
 * {@code instance-of} 都能正常求值。
 *
 * <p><b>为什么这个类「存在」本身就很重要：</b>缺少它时，{@code Init.init(Context)} 会在
 * 解析常量池里的 {@code dalvik/system/DexClassLoader} 时抛 {@code NoClassDefFoundError}，
 * 于是 Init 的静态 Context 字段永远不被赋值 → 蜘蛛构造函数里读
 * {@code Init.context().getCacheDir()} 抛空指针。用户看到的是一句与真实原因
 * 毫无关联的 NPE。补上本类后，失败点会前移到「原生方法未实现」，语义清晰得多。
 *
 * <p>能力边界见 {@link BaseDexClassLoader} 的类注释（裸 {@code .dex} 与安卓
 * {@code .so} 在桌面 JVM 上无法执行，属架构限制，不是移植缺陷）。
 */
public class DexClassLoader extends BaseDexClassLoader {

    public DexClassLoader(String dexPath, String optimizedDirectory,
                          String librarySearchPath, ClassLoader parent) {
        super(dexPath, optimizedDirectory, librarySearchPath, parent);
    }

    public DexClassLoader(String dexPath, File optimizedDirectory,
                          String librarySearchPath, ClassLoader parent) {
        super(dexPath, optimizedDirectory, librarySearchPath, parent);
    }
}
