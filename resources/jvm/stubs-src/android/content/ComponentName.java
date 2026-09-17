package android.content;

import android.os.Parcel;
import android.os.Parcelable;

/**
 * ComponentName stub —— 组件标识（包名 + 类名）。
 *
 * ★ 2026-09-10 第四轮修复：此前只有 `(String,String)` 构造器，
 *   而混淆库/AIDL 会用 `(Context, Class)` / `(Context, String)`。
 *   这里按真实调用面补齐，并保证 getPackageName/getClassName/getShortClassName 可用。
 */
public class ComponentName implements Parcelable, Cloneable {

    private final String mPackage;
    private final String mClass;

    public ComponentName(String pkg, String cls) {
        if (pkg == null || cls == null) {
            throw new NullPointerException("package name and class name must not be null");
        }
        mPackage = pkg;
        mClass = cls;
    }

    public ComponentName(Context pkg, String cls) {
        this(pkg == null ? null : pkg.getPackageName(), cls);
    }

    public ComponentName(Context pkg, Class<?> cls) {
        this(pkg == null ? null : pkg.getPackageName(), cls == null ? null : cls.getName());
    }

    private ComponentName(Parcel in) {
        mPackage = null;
        mClass = null;
    }

    public static ComponentName createRelative(String pkg, String cls) {
        return new ComponentName(pkg, cls);
    }

    public static ComponentName createRelative(Context pkg, String cls) {
        return new ComponentName(pkg, cls);
    }

    public static ComponentName unflattenFromString(String str) {
        if (str == null) {
            return null;
        }
        int sep = str.indexOf('/');
        if (sep < 0) {
            return null;
        }
        return new ComponentName(str.substring(0, sep), str.substring(sep + 1));
    }

    public String getPackageName() {
        return mPackage;
    }

    public String getClassName() {
        return mClass;
    }

    public String getShortClassName() {
        if (mClass == null) {
            return null;
        }
        if (mClass.startsWith(mPackage)) {
            int PN = mPackage.length();
            int CN = mClass.length();
            if (CN > PN && mClass.charAt(PN) == '.') {
                return mClass.substring(PN);
            }
        }
        int lastDot = mClass.lastIndexOf('.');
        if (lastDot < 1) {
            return mClass;
        }
        return mClass.substring(lastDot);
    }

    public String flattenToString() {
        return mPackage + "/" + mClass;
    }

    public String flattenToShortString() {
        return mPackage + "/" + getShortClassName();
    }

    public ComponentName clone() {
        return new ComponentName(mPackage, mClass);
    }

    public boolean equals(Object obj) {
        if (obj == null || !(obj instanceof ComponentName)) {
            return false;
        }
        ComponentName other = (ComponentName) obj;
        return eq(mPackage, other.mPackage) && eq(mClass, other.mClass);
    }

    public int hashCode() {
        return (mPackage == null ? 0 : mPackage.hashCode())
                ^ (mClass == null ? 0 : mClass.hashCode());
    }

    public String toString() {
        return "ComponentInfo{" + mPackage + "/" + mClass + "}";
    }

    public void writeToParcel(Parcel out, int flags) {
        out.writeString(mPackage);
        out.writeString(mClass);
    }

    @Override
    public int describeContents() {
        return 0;
    }

    public static final Creator<ComponentName> CREATOR = new Creator<ComponentName>() {
        @Override
        public ComponentName createFromParcel(Parcel in) {
            return new ComponentName(in);
        }

        @Override
        public ComponentName[] newArray(int size) {
            return new ComponentName[size];
        }
    };

    private static boolean eq(Object a, Object b) {
        return a == b || (a != null && a.equals(b));
    }
}
