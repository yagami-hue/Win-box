package dalvik.system;

import java.io.File;

/**
 * PathClassLoader stub —— 安卓加载「已安装 apk / 系统路径」上类的加载器。
 *
 * <p>与 {@link DexClassLoader} 同一血统（{@code extends BaseDexClassLoader}）。
 * 有些加固代码不直接用 DexClassLoader，而是先试 PathClassLoader
 * （因为宿主 App 自己的类就在它的路径里）。
 */
public class PathClassLoader extends BaseDexClassLoader {

    public PathClassLoader(String dexPath, ClassLoader parent) {
        super(dexPath, (File) null, null, parent);
    }

    public PathClassLoader(String dexPath, String librarySearchPath, ClassLoader parent) {
        super(dexPath, (File) null, librarySearchPath, parent);
    }
}
