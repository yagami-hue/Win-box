package android.content.res;

/** Resources stub（蜘蛛读 getString/getIdentifier；桌面版返回中性值）。 */
public class Resources {
    public Resources() { }
    public String getString(int id) { return ""; }
    public String getString(int id, Object... formatArgs) { return ""; }
    public int getIdentifier(String name, String defType, String defPackage) { return 0; }
    public android.util.DisplayMetrics getDisplayMetrics() { return new android.util.DisplayMetrics(); }
}
