package android.text.format;

import android.content.Context;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Formatter stub —— ★ 2026-09-27 新补（真机取证：wex 仓指纹助手把
 *   `WifiInfo.getIpAddress()` 的 int 交给 `Formatter.formatIpAddress(int)` 转成 "a.b.c.d"；
 *   缺类时整源 `ClassNotFoundException: android.text.format.Formatter`）。
 *
 * <p>{@link #formatIpAddress(int)} 与 AOSP 同实现（**little-endian** 口径，与
 * {@code WifiManager.localIpv4()} 的字节序一致）；文件大小/时间格式按 AOSP 的常用分支给等价结果。
 */
public class Formatter {

    // 与 android.text.format.DateFormat 对齐的时间标志（这里只做常用分支）
    public static final int SHORT = 0x00000001;
    public static final int LONG = 0x00000002;
    public static final int DATE = 0x00000001;
    public static final int TIME = 0x00000002;
    public static final int ABBREV_MONTH = 0x00100000;

    public Formatter() {
    }

    /** AOSP 原实现：int 按 little-endian 展开为 IPv4 点分字符串 */
    public static String formatIpAddress(int ipv4Address) {
        return (ipv4Address & 0xff) + "." + ((ipv4Address >>> 8) & 0xff) + "."
                + ((ipv4Address >>> 16) & 0xff) + "." + ((ipv4Address >>> 24) & 0xff);
    }

    public static String formatFileSize(Context context, long number) {
        return sizeOf(number, false);
    }

    public static String formatShortFileSize(Context context, long number) {
        return sizeOf(number, true);
    }

    public static String formatDateTime(Context context, long millis, int flags) {
        String pattern = (flags == DATE) ? "yyyy-MM-dd" : "yyyy-MM-dd HH:mm";
        return new SimpleDateFormat(pattern, Locale.getDefault()).format(new Date(millis));
    }

    public static String formatDateRange(Context context, long startMillis, long endMillis, int flags) {
        return formatDateTime(context, startMillis, flags);
    }

    public static void formatDuration(long duration, StringBuilder builder) {
        long totalSeconds = duration / 1000L;
        long hours = totalSeconds / 3600L;
        long minutes = (totalSeconds % 3600L) / 60L;
        long seconds = totalSeconds % 60L;
        builder.setLength(0);
        if (hours > 0) builder.append(String.format(Locale.US, "%d:%02d:%02d", hours, minutes, seconds));
        else builder.append(String.format(Locale.US, "%02d:%02d", minutes, seconds));
    }

    public static String formatDuration(long duration) {
        StringBuilder sb = new StringBuilder();
        formatDuration(duration, sb);
        return sb.toString();
    }

    private static String sizeOf(long number, boolean shorter) {
        if (number < 1024L) return number + " B";
        double kb = number / 1024.0;
        if (kb < 1024.0) return String.format(Locale.US, shorter ? "%.0f KB" : "%.2f KB", kb);
        double mb = kb / 1024.0;
        if (mb < 1024.0) return String.format(Locale.US, shorter ? "%.0f MB" : "%.2f MB", mb);
        double gb = mb / 1024.0;
        return String.format(Locale.US, shorter ? "%.0f GB" : "%.2f GB", gb);
    }
}