package android.content.pm;

/** ApplicationInfo stub。 */
public class ApplicationInfo {
    public String packageName = "com.github.tvbox.osc";
    public String name = "TVBox";
    public String sourceDir = "";
    public String dataDir = "";
    public int flags = 0;
    public int uid = 0;
    public boolean enabled = true;
    // ★ 2026-09-27（壳通解）：加固壳会读这些字段做环境判定；缺字段 = NoSuchFieldError
    //   （实测 wex：守卫线程 `Exception in thread "Thread-9" java.lang.NoSuchFieldError: targetSdkVersion`）
    public int targetSdkVersion = 34;
    public int minSdkVersion = 21;
    public String nativeLibraryDir = "";
    public String processName = "com.github.tvbox.osc";
}
