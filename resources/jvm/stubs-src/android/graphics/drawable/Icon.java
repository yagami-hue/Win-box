package android.graphics.drawable;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.drawable.Icon;
import android.os.Parcel;
import android.os.Parcelable;

/**
 * Icon stub —— 应用图标（android.graphics.drawable.Icon）。
 *
 * ★ 真实调用面（扫描确认）：`getResId()I`
 *   桌面版无资源体系：getResId() 返回 0（"无资源 ID"），
 *   所有 loadDrawable 返回 null。调用方拿到 0 通常会跳过图标绘制。
 */
public class Icon implements Parcelable {

    public static final int TYPE_BITMAP = 1;
    public static final int TYPE_RESOURCE = 2;
    public static final int TYPE_DATA = 3;
    public static final int TYPE_URI = 4;
    public static final int TYPE_URI_ADAPTIVE_BITMAP = 5;

    private final int type;
    private final int resId;

    private Icon(int type, int resId) {
        this.type = type;
        this.resId = resId;
    }

    public static Icon createWithResource(Context context, int resId) {
        return new Icon(TYPE_RESOURCE, resId);
    }

    public static Icon createWithResource(String resPackage, int resId) {
        return new Icon(TYPE_RESOURCE, resId);
    }

    public static Icon createWithBitmap(android.graphics.Bitmap bits) {
        return new Icon(TYPE_BITMAP, 0);
    }

    public static Icon createWithData(byte[] data, int offset, int length) {
        return new Icon(TYPE_DATA, 0);
    }

    public static Icon createWithContentUri(String uri) {
        return new Icon(TYPE_URI, 0);
    }

    public static Icon createWithContentUri(android.net.Uri uri) {
        return new Icon(TYPE_URI, 0);
    }

    public static Icon createWithFilePath(String path) {
        return new Icon(TYPE_URI, 0);
    }

    public int getType() {
        return type;
    }

    /** ★ 返回 0 = 无资源 ID（桌面版无资源表），调用方据此跳过图标加载 */
    public int getResId() {
        return resId;
    }

    public String getResPackage() {
        return "org.tvbox.desktop";
    }

    public android.graphics.Bitmap getBitmap() {
        return null;
    }

    public byte[] getDataBytes() {
        return null;
    }

    public android.net.Uri getUri() {
        return null;
    }

    public Drawable loadDrawable(Context context) {
        return null;
    }

    public void loadDrawableAsync(Context context, OnDrawableLoadedListener listener,
                                  android.os.Handler handler) {
    }

    @Override
    public int describeContents() {
        return 0;
    }

    @Override
    public void writeToParcel(Parcel dest, int flags) {
    }

    public static final Creator<Icon> CREATOR = new Creator<Icon>() {
        @Override
        public Icon createFromParcel(Parcel source) {
            return new Icon(TYPE_RESOURCE, 0);
        }

        @Override
        public Icon[] newArray(int size) {
            return new Icon[size];
        }
    };

    public interface OnDrawableLoadedListener {
        void onDrawableLoaded(Drawable d);
    }
}
