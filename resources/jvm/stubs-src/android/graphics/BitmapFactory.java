package android.graphics;

import java.io.InputStream;

/**
 * BitmapFactory stub —— 图片解码。
 *
 * 桌面版无 Android 图形栈：所有 decode* 返回 null（"解码失败"）。
 * 这是可接受的降级 —— 图片加载在本移植中由渲染层（Electron）承担，
 * JVM 侧蜘蛛即使拿到 null 也应继续走文本链路。
 */
public class BitmapFactory {

    private BitmapFactory() {
    }

    public static Bitmap decodeFile(String pathName) {
        return null;
    }

    public static Bitmap decodeFile(String pathName, Options opts) {
        return null;
    }

    public static Bitmap decodeStream(InputStream is) {
        return null;
    }

    public static Bitmap decodeStream(InputStream is, android.graphics.Rect outPadding, Options opts) {
        return null;
    }

    public static Bitmap decodeByteArray(byte[] data, int offset, int length) {
        return null;
    }

    public static Bitmap decodeByteArray(byte[] data, int offset, int length, Options opts) {
        return null;
    }

    public static Bitmap decodeResource(android.content.res.Resources res, int id) {
        return null;
    }

    public static Bitmap decodeResource(android.content.res.Resources res, int id, Options opts) {
        return null;
    }

    public static Bitmap decodeResourceStream(android.content.res.Resources res, android.util.TypedValue value,
                                              InputStream is, android.graphics.Rect pad, Options opts) {
        return null;
    }

    /** Options stub —— 只承载解码参数，不参与实际解码 */
    public static class Options {

        public boolean inJustDecodeBounds = false;
        public int inSampleSize = 1;
        public Bitmap.Config inPreferredConfig = Bitmap.Config.ARGB_8888;
        public int outWidth = 0;
        public int outHeight = 0;
        public String outMimeType = null;
        public boolean inMutable = false;
        public boolean inScaled = true;

        public Options() {
        }

        public void requestCancelDecode() {
        }
    }
}
