package android.content.pm;

/**
 * PackageInfo stub：桌面移植版返回占位信息（versionName / packageName 非空）。
 *
 * 注意 signatures 字段必须存在：部分蜘蛛会直接读
 * `context.getPackageManager().getPackageInfo(pkg, GET_SIGNATURES).signatures`
 * 做签名校验，字段缺失会抛 NoSuchFieldError（不是 ClassNotFoundException，
 * 更隐蔽，因为类本身是找到了的）。
 */
public class PackageInfo {
    public String packageName = "com.github.tvbox.osc";
    public String versionName = "1.0.0";
    public int versionCode = 1;
    public ApplicationInfo applicationInfo = new ApplicationInfo();
    public long firstInstallTime = 0L;
    public long lastUpdateTime = 0L;
    public String sharedUserId;
    public int sharedUserLabel;
    public String[] requestedPermissions;
    public int[] requestedPermissionsFlags;
    // ★ 必须非空：蜘蛛会取 signatures[0].toByteArray() 当解密密钥用
    public Signature[] signatures = new Signature[]{new Signature(null)};
    public android.content.pm.ActivityInfo[] activities;
    public android.content.pm.ServiceInfo[] services;
    public android.content.pm.ProviderInfo[] providers;
    public android.content.pm.InstrumentationInfo[] instrumentation;
    public android.content.pm.PermissionInfo[] permissions;
    public android.content.pm.FeatureInfo[] reqFeatures;
    public android.content.pm.ConfigurationInfo[] configPreferences;
    public long[] gids;
}
