package android.util;

/** TypedValue stub（蜘蛛读 density 做 dp→px 换算）。 */
public class TypedValue {
    public static final int COMPLEX_UNIT_DIP = 1;
    public static final int COMPLEX_UNIT_PX = 0;
    public static final int COMPLEX_UNIT_SP = 2;

    public int type = 0;
    public float data = 0f;

    public static float applyDimension(int unit, float value, android.util.DisplayMetrics metrics) {
        if (metrics == null) return value;
        switch (unit) {
            case COMPLEX_UNIT_DIP:
                return value * metrics.density;
            case COMPLEX_UNIT_SP:
                return value * metrics.scaledDensity;
            default:
                return value;
        }
    }
}
