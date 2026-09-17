package android.view;

/**
 * Display stub —— 物理显示屏信息（内嵌 WebView 库用它算 DPI/屏幕尺寸）。
 *
 * <p>真实调用面（扫描确认，merge/h1/j/k）：
 * {@code getRotation()} / {@code getWidth()} / {@code getHeight()} /
 * {@code getMetrics(DisplayMetrics)} / {@code getRealMetrics(DisplayMetrics)}。
 *
 * <p>桌面端给一个"横屏 1920x1080、密度 1.0"的稳定快照：不返回 null、
 * 不抛异常，让调用方的尺寸计算有确定的输入。
 *
 * <p>★ 这里的常量用**字面量**而非引用 android.view.Surface /
 * android.content.res.Configuration：那两个类在本 stub 体系里没有，
 * 引用它们会把编译期的可选依赖变成硬依赖。
 */
public class Display {

    public static final int DEFAULT_DISPLAY = 0;

    /** 与 android.view.Surface.ROTATION_0 相同的值（0=自然方向）。 */
    private static final int ROTATION_0 = 0;
    /** 与 android.content.res.Configuration.ORIENTATION_LANDSCAPE 相同的值。 */
    private static final int ORIENTATION_LANDSCAPE = 2;

    protected Display() {
    }

    public int getDisplayId() {
        return DEFAULT_DISPLAY;
    }

    public int getWidth() {
        return 1920;
    }

    public int getHeight() {
        return 1080;
    }

    public int getRotation() {
        return ROTATION_0;
    }

    public int getOrientation() {
        return ORIENTATION_LANDSCAPE;
    }

    public int getPixelFormat() {
        return 1;
    }

    public float getRefreshRate() {
        return 60f;
    }

    public float[] getSupportedRefreshRates() {
        return new float[]{60f};
    }

    public long getAppVsyncOffsetNanos() {
        return 0L;
    }

    public void getMetrics(android.util.DisplayMetrics outMetrics) {
        fill(outMetrics);
    }

    public void getRealMetrics(android.util.DisplayMetrics outMetrics) {
        fill(outMetrics);
    }

    public void getSize(android.graphics.Point outSize) {
        if (outSize != null) {
            outSize.x = 1920;
            outSize.y = 1080;
        }
    }

    public void getRealSize(android.graphics.Point outSize) {
        getSize(outSize);
    }

    public void getCurrentSizeRange(android.graphics.Point outSmallestSize, android.graphics.Point outLargestSize) {
        if (outSmallestSize != null) {
            outSmallestSize.x = 1920;
            outSmallestSize.y = 1080;
        }
        if (outLargestSize != null) {
            outLargestSize.x = 1920;
            outLargestSize.y = 1080;
        }
    }

    public boolean isValid() {
        return true;
    }

    @Override
    public String toString() {
        return "Display(1920x1080, land)";
    }

    private static void fill(android.util.DisplayMetrics m) {
        if (m == null) return;
        m.widthPixels = 1920;
        m.heightPixels = 1080;
        m.density = 1.0f;
        m.densityDpi = 160;
        m.scaledDensity = 1.0f;
        m.xdpi = 160f;
        m.ydpi = 160f;
    }
}
