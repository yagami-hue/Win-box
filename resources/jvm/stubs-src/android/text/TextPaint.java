package android.text;

/**
 * TextPaint stub —— 文本绘制画笔（TextView 内部用它排版）。
 *
 * <p>真实调用面（扫描确认，merge/m/a、merge/p/a）：
 * 继承自 Paint 的 {@code setColor}/{@code setTextSize}/{@code setAntiAlias} 等，
 * 以及 {@code baselineShift}、{@code bgColor}、{@code linkColor} 字段。
 *
 * <p>★ 桌面端没有 android.graphics.Paint（本 stub 体系也未实现），因此这里
 * **自带一套字段**而不去继承不存在的父类。蜘蛛只做"属性设置"而不会真的绘制，
 * 所以只要字段存在 + setter 可调用即可。
 */
public class TextPaint {

    public int color = 0xFF000000;
    public float textSize = 16f;
    public float textScaleX = 1.0f;
    public float textSkewX = 0f;
    public float strokeWidth = 0f;
    public float density = 1.0f;
    public int baselineShift = 0;
    public int bgColor = 0;
    public int linkColor = 0;
    public int drawableState;
    public boolean antiAlias = true;
    public boolean underlineText = false;
    public boolean strikeThruText = false;
    public boolean fakeBoldText = false;
    public boolean subpixelText = false;
    public boolean linearText = false;
    public android.graphics.Typeface typeface = android.graphics.Typeface.DEFAULT;
    public int flags = 0;
    public int style = 0;

    public TextPaint() {
    }

    public TextPaint(int flags) {
        this.flags = flags;
    }

    public TextPaint(TextPaint paint) {
        if (paint != null) {
            this.color = paint.color;
            this.textSize = paint.textSize;
            this.typeface = paint.typeface;
        }
    }

    public void set(TextPaint tp) {
        if (tp == null) return;
        this.color = tp.color;
        this.textSize = tp.textSize;
        this.typeface = tp.typeface;
    }

    public void setColor(int color) {
        this.color = color;
    }

    public int getColor() {
        return color;
    }

    public void setTextSize(float textSize) {
        this.textSize = textSize;
    }

    public float getTextSize() {
        return textSize;
    }

    public void setTypeface(android.graphics.Typeface tf) {
        this.typeface = tf;
    }

    public android.graphics.Typeface getTypeface() {
        return typeface;
    }

    public void setAntiAlias(boolean aa) {
        this.antiAlias = aa;
    }

    public boolean isAntiAlias() {
        return antiAlias;
    }

    public void setUnderlineText(boolean underlineText) {
        this.underlineText = underlineText;
    }

    public void setStrikeThruText(boolean strikeThruText) {
        this.strikeThruText = strikeThruText;
    }

    public void setFakeBoldText(boolean fakeBoldText) {
        this.fakeBoldText = fakeBoldText;
    }

    public void setTextScaleX(float scaleX) {
        this.textScaleX = scaleX;
    }

    public void setTextSkewX(float skewX) {
        this.textSkewX = skewX;
    }

    public void setStrokeWidth(float width) {
        this.strokeWidth = width;
    }

    public void setFlags(int flags) {
        this.flags = flags;
    }

    public int getFlags() {
        return flags;
    }

    public void setStyle(int style) {
        this.style = style;
    }

    public int getStyle() {
        return style;
    }

    public void setDensity(float density) {
        this.density = density;
    }

    public float getDensity() {
        return density;
    }

    public void setSubpixelText(boolean subpixelText) {
        this.subpixelText = subpixelText;
    }

    public void setLinearText(boolean linearText) {
        this.linearText = linearText;
    }

    public void setBaselineShift(int baselineShift) {
        this.baselineShift = baselineShift;
    }

    public int getBaselineShift() {
        return baselineShift;
    }

    public void setBgColor(int bgColor) {
        this.bgColor = bgColor;
    }

    public int getBgColor() {
        return bgColor;
    }

    public void setLinkColor(int linkColor) {
        this.linkColor = linkColor;
    }

    public int getLinkColor() {
        return linkColor;
    }

    /** 文本宽度测量：桌面端无字体度量，按"每字符 0.6em"估算，保证非零。 */
    public float measureText(String text) {
        if (text == null) return 0f;
        return text.length() * textSize * 0.6f;
    }

    public float measureText(CharSequence text, int start, int end) {
        return text == null ? 0f : Math.max(0, end - start) * textSize * 0.6f;
    }

    public int breakText(String text, boolean measureForwards, float maxWidth, float[] measuredWidth) {
        if (text == null || maxWidth <= 0) {
            if (measuredWidth != null && measuredWidth.length > 0) measuredWidth[0] = 0f;
            return 0;
        }
        float perChar = Math.max(1f, textSize * 0.6f);
        int n = (int) (maxWidth / perChar);
        n = Math.min(n, text.length());
        if (measuredWidth != null && measuredWidth.length > 0) measuredWidth[0] = n * perChar;
        return n;
    }

    public int getTextWidths(String text, float[] widths) {
        if (text == null || widths == null) return 0;
        int n = Math.min(text.length(), widths.length);
        for (int i = 0; i < n; i++) widths[i] = textSize * 0.6f;
        return n;
    }
}
