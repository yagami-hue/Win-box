package android.graphics;

/**
 * Typeface stub —— 字体。
 *
 * <p>真实调用面（扫描确认，Notice / merge/d 系）：
 * 静态常量 {@code DEFAULT} / {@code DEFAULT_BOLD} / {@code SANS_SERIF} /
 * {@code SERIF} / {@code MONOSPACE}，以及 {@code create(String,int)}、
 * {@code createFromFile(String)}、{@code setTypeface}/{@code getTypeface}。
 *
 * <p>★ 静态常量**必须非 null**：蜘蛛构造 Typeface 链时若拿到 null，
 * 部分实现会拿它当参数再调 {@code Typeface.create(null,...)} 触发 NPE。
 * 这里给一个稳定的单例，且各常量互相区分（同引用会让 equals 判断串味）。
 */
public class Typeface {

    public static final int NORMAL = 0;
    public static final int BOLD = 1;
    public static final int ITALIC = 2;
    public static final int BOLD_ITALIC = 3;

    public static final Typeface DEFAULT = new Typeface("default");
    public static final Typeface DEFAULT_BOLD = new Typeface("default-bold", BOLD);
    public static final Typeface SANS_SERIF = new Typeface("sans-serif");
    public static final Typeface SERIF = new Typeface("serif");
    public static final Typeface MONOSPACE = new Typeface("monospace");

    private final String mFamily;
    private final int mStyle;

    private Typeface(String family) {
        this(family, NORMAL);
    }

    private Typeface(String family, int style) {
        this.mFamily = family == null ? "" : family;
        this.mStyle = style;
    }

    public static Typeface create(String familyName, int style) {
        return new Typeface(familyName, style);
    }

    public static Typeface create(Typeface family, int style) {
        return new Typeface(family == null ? "" : family.mFamily, style);
    }

    public static Typeface createFromFile(String path) {
        return new Typeface(path);
    }

    public static Typeface createFromFile(java.io.File path) {
        return new Typeface(path == null ? "" : path.getPath());
    }

    public static Typeface defaultFromStyle(int style) {
        return style == BOLD ? DEFAULT_BOLD : DEFAULT;
    }

    public int getStyle() {
        return mStyle;
    }

    public boolean isBold() {
        return mStyle == BOLD || mStyle == BOLD_ITALIC;
    }

    public boolean isItalic() {
        return mStyle == ITALIC || mStyle == BOLD_ITALIC;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof Typeface)) return false;
        Typeface t = (Typeface) o;
        return mStyle == t.mStyle && mFamily.equals(t.mFamily);
    }

    @Override
    public int hashCode() {
        return mFamily.hashCode() * 31 + mStyle;
    }

    @Override
    public String toString() {
        return "Typeface(" + mFamily + "," + mStyle + ")";
    }
}
