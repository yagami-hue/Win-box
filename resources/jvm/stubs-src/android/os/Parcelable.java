package android.os;

/**
 * Parcelable stub —— Android 序列化接口。
 *
 * 桌面 JVM 桥不做 Binder 跨进程传输，因此这里只需要：
 * - 类可加载（消除 ClassNotFoundException）
 * - 常量完整（PARCELABLE_WRITE_RETURN_VALUE / CONTENTS_FILE_DESCRIPTOR，混淆代码常直接读）
 * - 嵌套接口 Creator<T> / ClassLoaderCreator<T> 存在（Room 生成类会 implements Parcelable.Creator）
 */
public interface Parcelable {

    int PARCELABLE_WRITE_RETURN_VALUE = 0x0001;
    int CONTENTS_FILE_DESCRIPTOR = 0x0001;

    int describeContents();

    void writeToParcel(Parcel dest, int flags);

    interface Creator<T> {
        T createFromParcel(Parcel source);
        T[] newArray(int size);
    }

    interface ClassLoaderCreator<T> extends Creator<T> {
        T createFromParcel(Parcel source, ClassLoader loader);
    }
}
