package android.content;

import android.net.Uri;
import android.os.Bundle;
import android.os.Parcel;
import android.os.Parcelable;

import java.util.ArrayList;
import java.util.Set;

/**
 * Intent stub —— 组件启动意图。
 *
 * ★ 2026-09-10 第四轮修复：此前 Intent 只有 4 个成员，导致混淆工具库
 *   （com.github.catvod.spider.merge.*）在 `new Intent(Context, Class)` 处
 *   抛 NoSuchMethodError。本次按真实调用面补齐。
 *
 * 设计：Intent 本质是**纯数据结构 + 链式 setter**。桌面版无组件体系，
 * 但 get 系列 / hasExtra 必须真实可用（蜘蛛会读回自己塞进去的 extra）。
 */
public class Intent implements Parcelable {

    public static final String ACTION_MAIN = "android.intent.action.MAIN";
    public static final String ACTION_VIEW = "android.intent.action.VIEW";
    public static final String ACTION_SEND = "android.intent.action.SEND";
    public static final String ACTION_SENDTO = "android.intent.action.SENDTO";
    public static final String ACTION_CHOOSER = "android.intent.action.CHOOSER";
    public static final String ACTION_GET_CONTENT = "android.intent.action.GET_CONTENT";
    public static final String ACTION_OPEN_DOCUMENT = "android.intent.action.OPEN_DOCUMENT";
    public static final String CATEGORY_LAUNCHER = "android.intent.category.LAUNCHER";
    public static final String CATEGORY_DEFAULT = "android.intent.category.DEFAULT";
    public static final String CATEGORY_BROWSABLE = "android.intent.category.BROWSABLE";
    public static final String EXTRA_STREAM = "android.intent.extra.STREAM";
    public static final String EXTRA_TEXT = "android.intent.extra.TEXT";
    public static final String EXTRA_SUBJECT = "android.intent.extra.SUBJECT";
    public static final String EXTRA_TITLE = "android.intent.extra.TITLE";
    public static final int FLAG_ACTIVITY_NEW_TASK = 0x10000000;
    public static final int FLAG_ACTIVITY_CLEAR_TOP = 0x04000000;
    public static final int FLAG_ACTIVITY_SINGLE_TOP = 0x20000000;
    public static final int FLAG_GRANT_READ_URI_PERMISSION = 0x00000001;
    public static final int FLAG_GRANT_WRITE_URI_PERMISSION = 0x00000002;

    private String action;
    private Uri data;
    private String type;
    private ComponentName component;
    private String packageName;
    private int flags;
    private final Bundle extras = new Bundle();
    private final ArrayList<String> categories = new ArrayList<String>();
    private String selectorTitle;

    // ---------------- 构造器（★ 混淆库用 Context+Class 那一个，必须有） ----------------

    public Intent() {
    }

    public Intent(String action) {
        this.action = action;
    }

    public Intent(String action, Uri data) {
        this.action = action;
        this.data = data;
    }

    public Intent(Context packageContext, Class<?> cls) {
        if (cls != null) {
            this.component = new ComponentName(packageContext, cls);
        }
    }

    public Intent(String action, Uri data, Context packageContext, Class<?> cls) {
        this.action = action;
        this.data = data;
        if (cls != null) {
            this.component = new ComponentName(packageContext, cls);
        }
    }

    public Intent(Intent o) {
        if (o != null) {
            this.action = o.action;
            this.data = o.data;
            this.type = o.type;
            this.component = o.component;
            this.packageName = o.packageName;
            this.flags = o.flags;
            this.extras.putAll(o.extras);
            this.categories.addAll(o.categories);
        }
    }

    private Intent(Parcel in) {
    }

    public static Intent createChooser(Intent target, CharSequence title) {
        Intent i = new Intent(ACTION_CHOOSER);
        i.selectorTitle = title == null ? null : title.toString();
        return i;
    }

    // ---------------- action / data / type ----------------

    public String getAction() {
        return action;
    }

    public Intent setAction(String action) {
        this.action = action;
        return this;
    }

    public Uri getData() {
        return data;
    }

    public Intent setData(Uri data) {
        this.data = data;
        return this;
    }

    public Intent setDataAndType(Uri data, String type) {
        this.data = data;
        this.type = type;
        return this;
    }

    public String getType() {
        return type;
    }

    public Intent setType(String type) {
        this.type = type;
        return this;
    }

    // ---------------- component / package / flags ----------------

    public ComponentName getComponent() {
        return component;
    }

    public Intent setComponent(ComponentName component) {
        this.component = component;
        return this;
    }

    public Intent setClassName(Context packageContext, String className) {
        this.component = new ComponentName(packageContext, className);
        return this;
    }

    public Intent setClassName(String packageName, String className) {
        this.component = new ComponentName(packageName, className);
        return this;
    }

    public Intent setClass(Context packageContext, Class<?> cls) {
        if (cls != null) {
            this.component = new ComponentName(packageContext, cls);
        }
        return this;
    }

    public String getPackage() {
        if (packageName != null) {
            return packageName;
        }
        return component == null ? null : component.getPackageName();
    }

    public Intent setPackage(String packageName) {
        this.packageName = packageName;
        return this;
    }

    public int getFlags() {
        return flags;
    }

    public Intent setFlags(int flags) {
        this.flags = flags;
        return this;
    }

    public Intent addFlags(int flags) {
        this.flags |= flags;
        return this;
    }

    public void removeFlags(int flags) {
        this.flags &= ~flags;
    }

    // ---------------- categories ----------------

    public Set<String> getCategories() {
        return new java.util.HashSet<String>(categories);
    }

    public Intent addCategory(String category) {
        if (category != null && !categories.contains(category)) {
            categories.add(category);
        }
        return this;
    }

    public void removeCategory(String category) {
        categories.remove(category);
    }

    public boolean hasCategory(String category) {
        return categories.contains(category);
    }

    // ---------------- extras ----------------

    public Bundle getExtras() {
        return extras;
    }

    public Intent putExtras(Bundle extras) {
        if (extras != null) {
            this.extras.putAll(extras);
        }
        return this;
    }

    public Intent putExtra(String name, String value) {
        extras.putString(name, value);
        return this;
    }

    public Intent putExtra(String name, int value) {
        extras.putInt(name, value);
        return this;
    }

    public Intent putExtra(String name, long value) {
        extras.putLong(name, value);
        return this;
    }

    public Intent putExtra(String name, boolean value) {
        extras.putBoolean(name, value);
        return this;
    }

    public Intent putExtra(String name, double value) {
        extras.putDouble(name, value);
        return this;
    }

    public Intent putExtra(String name, float value) {
        extras.putFloat(name, value);
        return this;
    }

    public Intent putExtra(String name, short value) {
        extras.putShort(name, value);
        return this;
    }

    public Intent putExtra(String name, byte value) {
        extras.putByte(name, value);
        return this;
    }

    public Intent putExtra(String name, char value) {
        extras.putChar(name, value);
        return this;
    }

    public Intent putExtra(String name, byte[] value) {
        extras.putByteArray(name, value);
        return this;
    }

    public Intent putExtra(String name, String[] value) {
        extras.putStringArray(name, value);
        return this;
    }

    public Intent putExtra(String name, CharSequence value) {
        extras.putCharSequence(name, value);
        return this;
    }

    public Intent putExtra(String name, Parcelable value) {
        extras.putParcelable(name, value);
        return this;
    }

    public Intent putExtra(String name, java.io.Serializable value) {
        extras.putSerializable(name, value);
        return this;
    }

    public Intent putIntegerArrayListExtra(String name, ArrayList<Integer> value) {
        extras.putIntegerArrayList(name, value);
        return this;
    }

    public Intent putStringArrayListExtra(String name, ArrayList<String> value) {
        extras.putStringArrayList(name, value);
        return this;
    }

    public String getStringExtra(String name) {
        return extras.getString(name);
    }

    public int getIntExtra(String name, int defaultValue) {
        return extras.getInt(name, defaultValue);
    }

    public long getLongExtra(String name, long defaultValue) {
        return extras.getLong(name, defaultValue);
    }

    public boolean getBooleanExtra(String name, boolean defaultValue) {
        return extras.getBoolean(name, defaultValue);
    }

    public double getDoubleExtra(String name, double defaultValue) {
        return extras.getDouble(name, defaultValue);
    }

    public float getFloatExtra(String name, float defaultValue) {
        return extras.getFloat(name, defaultValue);
    }

    public byte[] getByteArrayExtra(String name) {
        return extras.getByteArray(name);
    }

    public String[] getStringArrayExtra(String name) {
        return extras.getStringArray(name);
    }

    public CharSequence getCharSequenceExtra(String name) {
        return extras.getCharSequence(name);
    }

    @SuppressWarnings("unchecked")
    public <T extends Parcelable> T getParcelableExtra(String name) {
        return extras.getParcelable(name);
    }

    public java.io.Serializable getSerializableExtra(String name) {
        return extras.getSerializable(name);
    }

    public ArrayList<Integer> getIntegerArrayListExtra(String name) {
        Object v = extras.get(name);
        @SuppressWarnings("unchecked")
        ArrayList<Integer> out = v instanceof ArrayList ? (ArrayList<Integer>) v : null;
        return out;
    }

    public ArrayList<String> getStringArrayListExtra(String name) {
        Object v = extras.get(name);
        @SuppressWarnings("unchecked")
        ArrayList<String> out = v instanceof ArrayList ? (ArrayList<String>) v : null;
        return out;
    }

    public boolean hasExtra(String name) {
        return extras.containsKey(name);
    }

    public Intent removeExtra(String name) {
        extras.remove(name);
        return this;
    }

    public Intent replaceExtras(Bundle extras) {
        // 用新 Bundle 覆盖（简化：清空后 putAll）
        for (String k : new java.util.ArrayList<String>(this.extras.keySet())) {
            this.extras.remove(k);
        }
        if (extras != null) {
            this.extras.putAll(extras);
        }
        return this;
    }

    // ---------------- 其它 ----------------

    public Intent cloneFilter() {
        return new Intent(this);
    }

    public Object clone() {
        return new Intent(this);
    }

    public String getScheme() {
        return data == null ? null : data.getScheme();
    }

    public Intent setIdentifier(String identifier) {
        return this;
    }

    public String getIdentifier() {
        return null;
    }

    public Intent setSelector(Intent selector) {
        return this;
    }

    public Intent getSelector() {
        return null;
    }

    public Intent setSourceBounds(android.graphics.Rect r) {
        return this;
    }

    public android.graphics.Rect getSourceBounds() {
        return null;
    }

    public String toString() {
        StringBuilder sb = new StringBuilder("Intent{");
        if (action != null) sb.append(" act=").append(action);
        if (data != null) sb.append(" dat=").append(data);
        if (component != null) sb.append(" cmp=").append(component);
        return sb.append(" }").toString();
    }

    // ---------------- Parcelable ----------------

    @Override
    public int describeContents() {
        return 0;
    }

    @Override
    public void writeToParcel(Parcel dest, int flags) {
    }

    public static final Creator<Intent> CREATOR = new Creator<Intent>() {
        @Override
        public Intent createFromParcel(Parcel source) {
            return new Intent(source);
        }

        @Override
        public Intent[] newArray(int size) {
            return new Intent[size];
        }
    };
}
