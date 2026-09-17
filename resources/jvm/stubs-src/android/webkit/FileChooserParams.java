package android.webkit;

import android.net.Uri;

/**
 * FileChooserParams stub —— WebView 文件选择请求参数。
 *
 * <p>真实调用面：{@code getAcceptTypes()} / {@code isCaptureEnabled()} /
 * {@code getTitle()} / {@code getFilenameHint()} / {@code getMode()} /
 * {@code parseResult(int, android.content.Intent)}。
 * 桌面端无文件选择器，返回空值 + MODE_OPEN 即可（不返回 null，避免调用方 NPE）。
 */
public abstract class FileChooserParams {

    public static final int MODE_OPEN = 0;
    public static final int MODE_OPEN_MULTIPLE = 1;
    public static final int MODE_OPEN_FOLDER = 2;
    public static final int MODE_SAVE = 3;

    public static Uri[] parseResult(int resultCode, android.content.Intent intent) {
        return new Uri[0];
    }

    public abstract String[] getAcceptTypes();

    public abstract boolean isCaptureEnabled();

    public abstract CharSequence getTitle();

    public abstract String getFilenameHint();

    public abstract int getMode();

    public abstract android.content.Intent createIntent();
}
