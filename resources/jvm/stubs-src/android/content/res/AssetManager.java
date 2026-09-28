package android.content.res;

/**
 * AssetManager stub —— 加固壳 native 取「宿主 Assets 句柄」用（★ 2026-09-27 壳通解）。
 *
 * <p><b>为什么只要这么点：</b>壳的 native 调 {@code Context.getAssets()} 拿到本对象后，
 * 交给 {@code AAssetManager_fromJava(env, mgr)}，随后是 {@code AAssetManager_open(name, mode)}
 * → {@code AAsset_getBuffer/getLength/read/close}。这些 **AAssetManager_* / AAsset_* 符号**
 * 由 unidbg 的 libandroid 虚拟模块提供（见 {@code NativeBridge.installAssets}：把 jar 的
 * {@code assets/**} 全部登记进去）。所以 Java 侧本类不需要真的实现读资产 ——
 * 它只是「非 null 的句柄」，同时给纯 Java 代码（若能调到）一个可用的最小实现。
 */
public class AssetManager {

    public AssetManager() {
    }

    /**
     * Java 侧读取资产（少数壳的 Java 代码会走这里）。
     * 桌面版把 jar 的 assets 视作类路径资源 → 用类加载器取；取不到返回 null。
     */
    public java.io.InputStream open(String fileName) throws java.io.IOException {
        ClassLoader cl = getClass().getClassLoader();
        java.io.InputStream in = cl == null ? null : cl.getResourceAsStream("assets/" + fileName);
        if (in == null) in = cl == null ? null : cl.getResourceAsStream(fileName);
        if (in == null) throw new java.io.FileNotFoundException(fileName);
        return in;
    }

    public java.io.InputStream open(String fileName, int accessMode) throws java.io.IOException {
        return open(fileName);
    }

    public String[] list(String path) throws java.io.IOException {
        return new String[0];
    }

    public void close() {
    }
}