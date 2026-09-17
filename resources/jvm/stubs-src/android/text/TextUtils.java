package android.text;

/**
 * TextUtils stub —— 文本工具类。
 *
 * <p>真实调用面（扫描确认）：
 * <ul>
 *   <li>内部枚举 {@code TextUtils.TruncateAt}（在 {@code ellipsize} 里用，
 *       常量 START/MIDDLE/END/MARQUEE 必须齐全 —— 少一个是 NoSuchFieldError）</li>
 *   <li>{@code isEmpty(CharSequence)} / {@code join(CharSequence,Iterable)} /
 *       {@code join(CharSequence,Object[])} / {@code split(String,String)} /
 *       {@code isDigitsOnly} / {@code htmlEncode} / {@code concat}</li>
 * </ul>
 *
 * <p>★ 本类是**纯数据工具类**，必须真实实现（stub 三原则第一条）：
 * {@code isEmpty} 恒返回 true 会让蜘蛛的错误分支全走错，导致"没有报错但结果空"
 * 这类最难定位的问题。
 */
public class TextUtils {

    /** 省略号位置（安卓原版常量，勿删减）。 */
    public enum TruncateAt {
        START,
        MIDDLE,
        END,
        MARQUEE
    }

    private TextUtils() {
    }

    public static boolean isEmpty(CharSequence str) {
        return str == null || str.length() == 0;
    }

    public static int getTrimmedLength(CharSequence s) {
        if (s == null) return 0;
        int start = 0, end = s.length();
        while (start < end && Character.isWhitespace(s.charAt(start))) start++;
        while (end > start && Character.isWhitespace(s.charAt(end - 1))) end--;
        return end - start;
    }

    public static boolean equals(CharSequence a, CharSequence b) {
        return a == b || (a != null && b != null && a.toString().equals(b.toString()));
    }

    public static CharSequence concat(CharSequence... text) {
        StringBuilder sb = new StringBuilder();
        if (text != null) for (CharSequence t : text) if (t != null) sb.append(t);
        return sb.toString();
    }

    public static String join(CharSequence delimiter, Iterable<?> tokens) {
        StringBuilder sb = new StringBuilder();
        if (tokens != null) {
            boolean first = true;
            for (Object o : tokens) {
                if (first) first = false;
                else if (delimiter != null) sb.append(delimiter);
                sb.append(o);
            }
        }
        return sb.toString();
    }

    public static String join(CharSequence delimiter, Object[] tokens) {
        StringBuilder sb = new StringBuilder();
        if (tokens != null) {
            for (int i = 0; i < tokens.length; i++) {
                if (i > 0 && delimiter != null) sb.append(delimiter);
                sb.append(tokens[i]);
            }
        }
        return sb.toString();
    }

    public static String[] split(String text, String expression) {
        if (text == null || text.length() == 0) return new String[0];
        if (expression == null || expression.length() == 0) return new String[]{text};
        return text.split(java.util.regex.Pattern.quote(expression));
    }

    public static String[] split(String text, java.util.regex.Pattern pattern) {
        if (text == null || text.length() == 0) return new String[0];
        if (pattern == null) return new String[]{text};
        return pattern.split(text);
    }

    public static boolean isDigitsOnly(CharSequence str) {
        if (str == null) return false;
        int len = str.length();
        if (len == 0) return false;
        for (int i = 0; i < len; i++) {
            if (!Character.isDigit(str.charAt(i))) return false;
        }
        return true;
    }

    public static boolean isGraphic(CharSequence str) {
        if (str == null) return false;
        int len = str.length();
        for (int i = 0; i < len; i++) {
            if (!Character.isWhitespace(str.charAt(i))) return true;
        }
        return false;
    }

    public static int indexOf(CharSequence s, CharSequence needle) {
        return indexOf(s, needle, 0, s == null ? 0 : s.length());
    }

    public static int indexOf(CharSequence s, CharSequence needle, int start) {
        return indexOf(s, needle, start, s == null ? 0 : s.length());
    }

    public static int indexOf(CharSequence s, CharSequence needle, int start, int end) {
        if (s == null || needle == null) return -1;
        return s.toString().indexOf(needle.toString(), start);
    }

    public static CharSequence substring(CharSequence source, int start, int end) {
        if (source == null) return "";
        return source.subSequence(Math.max(0, start), Math.min(source.length(), Math.max(start, end)));
    }

    public static CharSequence ellipsize(CharSequence text, TextPaint p, float avail,
                                         TruncateAt where) {
        if (text == null) return "";
        if (p == null || p.measureText(text.toString()) <= avail) return text;
        String s = text.toString();
        int max = Math.max(0, (int) (avail / Math.max(1f, p.textSize * 0.6f)) - 1);
        return s.substring(0, Math.min(s.length(), max)) + "\u2026";
    }

    public static CharSequence expandTemplate(CharSequence template, CharSequence... values) {
        return template == null ? "" : template;
    }

    public static String htmlEncode(String s) {
        if (s == null) return "";
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                .replace("\"", "&quot;").replace("'", "&#39;");
    }

    public static CharSequence getReverse(CharSequence source, int start, int end) {
        if (source == null) return "";
        return new StringBuilder(source.subSequence(start, end)).reverse().toString();
    }

    public static int getOffsetBefore(CharSequence text, int offset) {
        return offset <= 0 ? 0 : offset - 1;
    }

    public static int getOffsetAfter(CharSequence text, int offset) {
        return text == null ? 0 : Math.min(text.length(), offset + 1);
    }

    public static boolean regionMatches(CharSequence one, int toffset, CharSequence two, int ooffset, int len) {
        if (one == null || two == null) return false;
        return one.toString().regionMatches(toffset, two.toString(), ooffset, len);
    }

    public static float getLayoutDirectionFromLocale(java.util.Locale locale) {
        return 0f;
    }

    public static CharSequence makeSafeForPresentation(String text, int maxCharactersToConsider,
                                                       float ellipsizeDip, int flags) {
        return text == null ? "" : text;
    }

    /** 供未使用场景查询：检测破坏性 Unicode（桌面端不做剥离）。 */
    public static boolean hasAnyLatinLetters(CharSequence str) {
        if (str == null) return false;
        for (int i = 0; i < str.length(); i++) {
            if (Character.isLetter(str.charAt(i))) return true;
        }
        return false;
    }
}
