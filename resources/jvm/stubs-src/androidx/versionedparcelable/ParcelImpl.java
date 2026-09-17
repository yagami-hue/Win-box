package androidx.versionedparcelable;

import android.os.Parcel;
import android.os.Parcelable;

/**
 * ParcelImpl stub —— androidx versionedparcelable 的 Parcel 包装。
 *
 * ★ 扫描确认：**只有混淆工具库**引用它，点播主链路不触达。
 *   这里做最小实现：可加载 + Parcelable 契约完整 + getParcel() 返回可用的空 Parcel。
 */
public class ParcelImpl implements Parcelable {

    private final Object value;

    public ParcelImpl(Parcel p) {
        this.value = null;
    }

    public ParcelImpl(Object value) {
        this.value = value;
    }

    public Object getValue() {
        return value;
    }

    public Parcel getParcel() {
        return Parcel.obtain();
    }

    @Override
    public int describeContents() {
        return 0;
    }

    @Override
    public void writeToParcel(Parcel dest, int flags) {
    }

    public static final Creator<ParcelImpl> CREATOR = new Creator<ParcelImpl>() {
        @Override
        public ParcelImpl createFromParcel(Parcel source) {
            return new ParcelImpl(source);
        }

        @Override
        public ParcelImpl[] newArray(int size) {
            return new ParcelImpl[size];
        }
    };
}
