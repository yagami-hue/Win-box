package android.os;

import java.util.HashMap;
import java.util.Set;

/**
 * Bundle stub —— Intent / IPC 的键值容器。
 *
 * ★ 与 ContentValues 同理：这是**纯数据结构**，不依赖 Android 系统能力，
 *   必须是功能完整的。用真实 HashMap 实现。
 */
public class Bundle implements Cloneable {

    private final HashMap<String, Object> map;

    public Bundle() {
        map = new HashMap<String, Object>();
    }

    public Bundle(Bundle b) {
        map = new HashMap<String, Object>();
        if (b != null) {
            map.putAll(b.map);
        }
    }

    public Bundle(int capacity) {
        map = new HashMap<String, Object>(capacity);
    }

    public void setClassLoader(ClassLoader loader) {
    }

    public ClassLoader getClassLoader() {
        return Bundle.class.getClassLoader();
    }

    public int size() {
        return map.size();
    }

    public boolean isEmpty() {
        return map.isEmpty();
    }

    public void clear() {
        map.clear();
    }

    public boolean containsKey(String key) {
        return map.containsKey(key);
    }

    public Object get(String key) {
        return map.get(key);
    }

    public void remove(String key) {
        map.remove(key);
    }

    public void putAll(Bundle bundle) {
        if (bundle != null) {
            map.putAll(bundle.map);
        }
    }

    public Set<String> keySet() {
        return map.keySet();
    }

    // ---------------- put ----------------

    public void putBoolean(String key, boolean value) { map.put(key, value); }
    public void putByte(String key, byte value) { map.put(key, value); }
    public void putChar(String key, char value) { map.put(key, value); }
    public void putShort(String key, short value) { map.put(key, value); }
    public void putInt(String key, int value) { map.put(key, value); }
    public void putLong(String key, long value) { map.put(key, value); }
    public void putFloat(String key, float value) { map.put(key, value); }
    public void putDouble(String key, double value) { map.put(key, value); }
    public void putString(String key, String value) { map.put(key, value); }
    public void putCharSequence(String key, CharSequence value) { map.put(key, value); }
    public void putParcelable(String key, Parcelable value) { map.put(key, value); }
    public void putIntegerArrayList(String key, java.util.ArrayList<Integer> value) { map.put(key, value); }
    public void putStringArrayList(String key, java.util.ArrayList<String> value) { map.put(key, value); }
    public void putSerializable(String key, java.io.Serializable value) { map.put(key, value); }
    public void putBundle(String key, Bundle value) { map.put(key, value); }
    public void putByteArray(String key, byte[] value) { map.put(key, value); }
    public void putStringArray(String key, String[] value) { map.put(key, value); }
    public void putParcelableArray(String key, Parcelable[] value) { map.put(key, value); }

    // ---------------- get ----------------

    public boolean getBoolean(String key) { return getBoolean(key, false); }
    public boolean getBoolean(String key, boolean defaultValue) {
        Object v = map.get(key);
        return v instanceof Boolean ? (Boolean) v : defaultValue;
    }

    public byte getByte(String key) { return getByte(key, (byte) 0); }
    public byte getByte(String key, byte defaultValue) {
        Object v = map.get(key);
        return v instanceof Number ? ((Number) v).byteValue() : defaultValue;
    }

    public char getChar(String key) { return getChar(key, (char) 0); }
    public char getChar(String key, char defaultValue) {
        Object v = map.get(key);
        return v instanceof Character ? (Character) v : defaultValue;
    }

    public short getShort(String key) { return getShort(key, (short) 0); }
    public short getShort(String key, short defaultValue) {
        Object v = map.get(key);
        return v instanceof Number ? ((Number) v).shortValue() : defaultValue;
    }

    public int getInt(String key) { return getInt(key, 0); }
    public int getInt(String key, int defaultValue) {
        Object v = map.get(key);
        return v instanceof Number ? ((Number) v).intValue() : defaultValue;
    }

    public long getLong(String key) { return getLong(key, 0L); }
    public long getLong(String key, long defaultValue) {
        Object v = map.get(key);
        return v instanceof Number ? ((Number) v).longValue() : defaultValue;
    }

    public float getFloat(String key) { return getFloat(key, 0f); }
    public float getFloat(String key, float defaultValue) {
        Object v = map.get(key);
        return v instanceof Number ? ((Number) v).floatValue() : defaultValue;
    }

    public double getDouble(String key) { return getDouble(key, 0d); }
    public double getDouble(String key, double defaultValue) {
        Object v = map.get(key);
        return v instanceof Number ? ((Number) v).doubleValue() : defaultValue;
    }

    public String getString(String key) {
        Object v = map.get(key);
        return v instanceof String ? (String) v : null;
    }

    public String getString(String key, String defaultValue) {
        String v = getString(key);
        return v != null ? v : defaultValue;
    }

    public CharSequence getCharSequence(String key) {
        Object v = map.get(key);
        return v instanceof CharSequence ? (CharSequence) v : null;
    }

    public Bundle getBundle(String key) {
        Object v = map.get(key);
        return v instanceof Bundle ? (Bundle) v : null;
    }

    public byte[] getByteArray(String key) {
        Object v = map.get(key);
        return v instanceof byte[] ? (byte[]) v : null;
    }

    public String[] getStringArray(String key) {
        Object v = map.get(key);
        return v instanceof String[] ? (String[]) v : null;
    }

    @SuppressWarnings("unchecked")
    public <T extends Parcelable> T getParcelable(String key) {
        Object v = map.get(key);
        return v instanceof Parcelable ? (T) v : null;
    }

    public java.io.Serializable getSerializable(String key) {
        Object v = map.get(key);
        return v instanceof java.io.Serializable ? (java.io.Serializable) v : null;
    }

    public Object clone() {
        return new Bundle(this);
    }

    public String toString() {
        return "Bundle" + map;
    }
}
