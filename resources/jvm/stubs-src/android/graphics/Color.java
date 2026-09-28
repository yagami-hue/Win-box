package android.graphics;

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Color stub —— 颜色工具类（★ 2026-09-26 新增）。
 *
 * ★ Braille 型纯计算类：必须功能完整。蜘蛛/壳 jar 的详情与 UI 代码会直接引用
 *   `Color.RED` 一类常量做静态初始化（缺类 → 整个类加载失败，真机实测：
 *   玩偶/盘搜等源「点开资源无详情」就是这条），还会用 `parseColor("#RRGGBB")`
 *   解析配置里的颜色串 —— 空壳会让颜色恒为 0（黑），故这里按 AOSP 语义实现。
 */
public class Color {

    public static final int BLACK = 0xFF000000;
    public static final int DKGRAY = 0xFF444444;
    public static final int GRAY = 0xFF888888;
    public static final int LTGRAY = 0xFFCCCCCC;
    public static final int WHITE = 0xFFFFFFFF;
    public static final int RED = 0xFFFF0000;
    public static final int GREEN = 0xFF00FF00;
    public static final int BLUE = 0xFF0000FF;
    public static final int YELLOW = 0xFFFFFF00;
    public static final int CYAN = 0xFF00FFFF;
    public static final int MAGENTA = 0xFFFF00FF;
    public static final int TRANSPARENT = 0;

    private static final Map<String, Integer> NAMES = new HashMap<String, Integer>();

    static {
        NAMES.put("black", BLACK);
        NAMES.put("darkgray", DKGRAY);
        NAMES.put("gray", GRAY);
        NAMES.put("lightgray", LTGRAY);
        NAMES.put("white", WHITE);
        NAMES.put("red", RED);
        NAMES.put("green", GREEN);
        NAMES.put("blue", BLUE);
        NAMES.put("yellow", YELLOW);
        NAMES.put("cyan", CYAN);
        NAMES.put("magenta", MAGENTA);
        NAMES.put("aqua", 0xFF00FFFF);
        NAMES.put("fuchsia", 0xFFFF00FF);
        NAMES.put("darkgrey", DKGRAY);
        NAMES.put("grey", GRAY);
        NAMES.put("lightgrey", LTGRAY);
        NAMES.put("lime", 0xFF00FF00);
        NAMES.put("maroon", 0xFF800000);
        NAMES.put("navy", 0xFF000080);
        NAMES.put("olive", 0xFF808000);
        NAMES.put("purple", 0xFF800080);
        NAMES.put("silver", 0xFFC0C0C0);
        NAMES.put("teal", 0xFF008080);
    }

    public static int alpha(int color) {
        return color >>> 24;
    }

    public static int red(int color) {
        return (color >> 16) & 0xFF;
    }

    public static int green(int color) {
        return (color >> 8) & 0xFF;
    }

    public static int blue(int color) {
        return color & 0xFF;
    }

    public static int rgb(int red, int green, int blue) {
        return (0xFF << 24) | (red << 16) | (green << 8) | blue;
    }

    public static int argb(int alpha, int red, int green, int blue) {
        return (alpha << 24) | (red << 16) | (green << 8) | blue;
    }

    /** AOSP 语义：`#RRGGBB` / `#AARRGGBB` / `#RGB` / `#ARGB`，或颜色名；非法输入抛 IllegalArgumentException */
    public static int parseColor(String colorString) {
        if (colorString == null) throw new IllegalArgumentException("Unknown color");
        if (colorString.charAt(0) == '#') {
            long color = Long.parseLong(colorString.substring(1), 16);
            if (colorString.length() == 7) {
                color |= 0x00000000FF000000L;
            } else if (colorString.length() == 9) {
                // 已是 AARRGGBB
            } else if (colorString.length() == 4) {
                long c = color;
                color = 0xFF000000L;
                color |= (c & 0xF00L) * 0x110000L;
                color |= (c & 0x0F0L) * 0x1100L;
                color |= (c & 0x00FL) * 0x11L;
            } else if (colorString.length() == 5) {
                long c = color;
                color = 0;
                color |= (c & 0xF000L) * 0x1100000L;
                color |= (c & 0x0F00L) * 0x110000L;
                color |= (c & 0x00F0L) * 0x1100L;
                color |= (c & 0x000FL) * 0x11L;
            } else {
                throw new IllegalArgumentException("Unknown color");
            }
            return (int) color;
        }
        Integer named = NAMES.get(colorString.toLowerCase(Locale.ROOT));
        if (named != null) return named;
        throw new IllegalArgumentException("Unknown color");
    }

    public static void RGBToHSV(int red, int green, int blue, float[] hsv) {
        if (hsv == null || hsv.length < 3) throw new IllegalArgumentException("hsv.length must be 3");
        float r = red / 255.0f;
        float g = green / 255.0f;
        float b = blue / 255.0f;
        float max = Math.max(r, Math.max(g, b));
        float min = Math.min(r, Math.min(g, b));
        float d = max - min;
        float h = 0f;
        float s = max == 0f ? 0f : d / max;
        if (d != 0f) {
            if (max == r) h = (g - b) / d + (g < b ? 6f : 0f);
            else if (max == g) h = (b - r) / d + 2f;
            else h = (r - g) / d + 4f;
            h *= 60f;
        }
        hsv[0] = h;
        hsv[1] = s;
        hsv[2] = max;
    }

    public static void colorToHSV(int color, float[] hsv) {
        RGBToHSV(red(color), green(color), blue(color), hsv);
    }

    public static int HSVToColor(float[] hsv) {
        return HSVToColor(0xFF, hsv);
    }

    public static int HSVToColor(int alpha, float[] hsv) {
        if (hsv == null || hsv.length < 3) throw new IllegalArgumentException("hsv.length must be 3");
        float h = hsv[0];
        float s = Math.min(1f, Math.max(0f, hsv[1]));
        float v = Math.min(1f, Math.max(0f, hsv[2]));
        if (s == 0f) {
            int c = (int) (v * 255f + 0.5f);
            return argb(alpha, c, c, c);
        }
        h = ((h % 360f) + 360f) % 360f / 60f;
        int i = (int) h;
        float f = h - i;
        float p = v * (1f - s);
        float q = v * (1f - s * f);
        float t = v * (1f - s * (1f - f));
        float r, g, b;
        switch (i) {
            case 0: r = v; g = t; b = p; break;
            case 1: r = q; g = v; b = p; break;
            case 2: r = p; g = v; b = t; break;
            case 3: r = p; g = q; b = v; break;
            case 4: r = t; g = p; b = v; break;
            default: r = v; g = p; b = q; break;
        }
        return argb(alpha, (int) (r * 255f + 0.5f), (int) (g * 255f + 0.5f), (int) (b * 255f + 0.5f));
    }
}