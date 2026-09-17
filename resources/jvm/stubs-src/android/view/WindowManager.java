package android.view;

import android.util.DisplayMetrics;

/**
 * WindowManager stub —— 窗口服务（内嵌 WebView 库用它拿 Display）。
 *
 * <p>真实调用面（扫描确认，merge/h1/j/k）：
 * {@code getDefaultDisplay()}；另常见 {@code getCurrentWindowMetrics()} /
 * {@code addView} / {@code removeView}（全屏自定义 View 用）。
 *
 * <p>★ 这是**能力入口类**，{@code getDefaultDisplay()} 绝不返回 null：
 * 内嵌库惯用 {@code wm.getDefaultDisplay().getRotation()} 链式调用，
 * 返回 null 就是 NPE（表现为蜘蛛内部异常，日志里看不出跟 stub 有关）。
 */
public interface WindowManager extends ViewManager {

    Display getDefaultDisplay();

    void removeViewImmediate(View view);

    /** 窗口布局参数（内嵌库 setLayoutParams 用）。 */
    class LayoutParams extends ViewGroup.LayoutParams {

        public static final int FLAG_ALLOW_LOCK_WHILE_SCREEN_ON = 0x00000001;
        public static final int FLAG_DIM_BEHIND = 0x00000002;
        public static final int FLAG_BLUR_BEHIND = 0x00000004;
        public static final int FLAG_NOT_FOCUSABLE = 0x00000008;
        public static final int FLAG_NOT_TOUCHABLE = 0x00000010;
        public static final int FLAG_NOT_TOUCH_MODAL = 0x00000020;
        public static final int FLAG_KEEP_SCREEN_ON = 0x00000080;
        public static final int FLAG_LAYOUT_IN_SCREEN = 0x00000100;
        public static final int FLAG_LAYOUT_NO_LIMITS = 0x00000200;
        public static final int FLAG_FULLSCREEN = 0x00000400;
        public static final int FLAG_FORCE_NOT_FULLSCREEN = 0x00000800;
        public static final int FLAG_DITHER = 0x00001000;
        public static final int FLAG_SECURE = 0x00002000;
        public static final int FLAG_SHOW_WALLPAPER = 0x00100000;
        public static final int FLAG_WATCH_OUTSIDE_TOUCH = 0x00040000;

        public static final int TYPE_APPLICATION = 2;
        public static final int TYPE_APPLICATION_ATTACHED_DIALOG = 1003;
        public static final int TYPE_PHONE = 2002;
        public static final int TYPE_SYSTEM_ALERT = 2003;
        public static final int TYPE_SYSTEM_OVERLAY = 2006;
        public static final int TYPE_TOAST = 2005;

        public static final int FIRST_SYSTEM_WINDOW = 2000;
        public static final int LAST_SYSTEM_WINDOW = 2999;
        public static final int LAST_APPLICATION_WINDOW = 99;
        public static final int FIRST_APPLICATION_WINDOW = 1;

        public static final int LAYOUT_CHILD_HORIZONTAL = 3;

        public int x;
        public int y;
        public int width;
        public int height;
        public int gravity;
        public int flags;
        public int type;
        public float alpha = 1.0f;
        public float dimAmount = 1.0f;
        public int format = -1;
        public int windowAnimations;
        public String packageName;
        public int softInputMode;

        public LayoutParams() {
            super(0, 0);
        }

        @Deprecated
        public LayoutParams(int type) {
            super(0, 0);
            this.type = type;
        }

        public LayoutParams(int width, int height) {
            super(width, height);
        }

        public LayoutParams(int width, int height, int type) {
            super(width, height);
            this.type = type;
        }

        public LayoutParams(int width, int height, int type, int flags, int format) {
            super(width, height);
            this.type = type;
            this.flags = flags;
            this.format = format;
        }

        public LayoutParams(android.os.Parcel parcel) {
            super(0, 0);
        }

        public int describeContents() {
            return 0;
        }

        public void writeToParcel(android.os.Parcel parcel, int flags) {
        }

        public String getTitle() {
            return packageName;
        }

        public void setTitle(CharSequence title) {
        }

        /** 供内嵌库调用（桌面端无输入法，仅记录）。 */
        public void setSoftInputMode(int mode) {
            this.softInputMode = mode;
        }

        public int getSoftInputMode() {
            return softInputMode;
        }
    }

    /** 兼容 API 30+ 的窗口度量入口（部分内嵌库版本会用）。 */
    class WindowMetrics {
        private final android.graphics.Rect bounds;

        public WindowMetrics(android.graphics.Rect bounds) {
            this.bounds = bounds == null ? new android.graphics.Rect(0, 0, 1920, 1080) : bounds;
        }

        public android.graphics.Rect getBounds() {
            return bounds;
        }

        public android.util.DisplayMetrics getDensity() {
            DisplayMetrics m = new DisplayMetrics();
            m.widthPixels = 1920;
            m.heightPixels = 1080;
            m.density = 1.0f;
            m.densityDpi = 160;
            m.scaledDensity = 1.0f;
            m.xdpi = 160f;
            m.ydpi = 160f;
            return m;
        }
    }

    /** 供 Context 相关静态引用可达（不参与实际逻辑）。 */
    @SuppressWarnings("unused")
    interface StubMarker {
    }
}
