package android.content;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;

/**
 * ContentValues stub —— 键值对容器（SQLite insert/update 的参数）。
 *
 * ★ 这个类**必须是功能完整的**：它是纯数据结构，不依赖任何 Android 系统能力，
 *   蜘蛛/Room 会往里 put 再读出来。做成空壳会导致数据静默丢失。
 *   因此这里用真实的 HashMap 实现（与 Android 行为一致）。
 */
public class ContentValues {

    private final HashMap<String, Object> values = new HashMap<String, Object>();

    public ContentValues() {
    }

    public ContentValues(int size) {
        // HashMap 的容量参数，Java 侧自动扩容，忽略即可
    }

    public ContentValues(ContentValues from) {
        if (from != null) {
            values.putAll(from.values);
        }
    }

    private ContentValues(HashMap<String, Object> from) {
        if (from != null) {
            values.putAll(from);
        }
    }

    public boolean equals(Object object) {
        if (!(object instanceof ContentValues)) {
            return false;
        }
        return values.equals(((ContentValues) object).values);
    }

    public int hashCode() {
        return values.hashCode();
    }

    public void put(String key, String value) {
        values.put(key, value);
    }

    public void put(String key, Byte value) {
        values.put(key, value);
    }

    public void put(String key, Short value) {
        values.put(key, value);
    }

    public void put(String key, Integer value) {
        values.put(key, value);
    }

    public void put(String key, Long value) {
        values.put(key, value);
    }

    public void put(String key, Float value) {
        values.put(key, value);
    }

    public void put(String key, Double value) {
        values.put(key, value);
    }

    public void put(String key, Boolean value) {
        values.put(key, value);
    }

    public void put(String key, byte[] value) {
        values.put(key, value);
    }

    public void putNull(String key) {
        values.put(key, null);
    }

    public void putAll(ContentValues other) {
        if (other != null) {
            values.putAll(other.values);
        }
    }

    public int size() {
        return values.size();
    }

    public void remove(String key) {
        values.remove(key);
    }

    public void clear() {
        values.clear();
    }

    public boolean containsKey(String key) {
        return values.containsKey(key);
    }

    public Object get(String key) {
        return values.get(key);
    }

    public String getAsString(String key) {
        Object value = values.get(key);
        return value != null ? value.toString() : null;
    }

    public Long getAsLong(String key) {
        Object value = values.get(key);
        return getAsLongValue(value);
    }

    public Integer getAsInteger(String key) {
        Object value = values.get(key);
        return getAsIntegerValue(value);
    }

    public Short getAsShort(String key) {
        Object value = values.get(key);
        if (value == null) {
            return null;
        }
        if (value instanceof Short) {
            return (Short) value;
        }
        if (value instanceof Number) {
            return ((Number) value).shortValue();
        }
        try {
            return Short.parseShort(value.toString());
        } catch (NumberFormatException e) {
            return null;
        }
    }

    public Byte getAsByte(String key) {
        Object value = values.get(key);
        if (value == null) {
            return null;
        }
        if (value instanceof Byte) {
            return (Byte) value;
        }
        if (value instanceof Number) {
            return ((Number) value).byteValue();
        }
        try {
            return Byte.parseByte(value.toString());
        } catch (NumberFormatException e) {
            return null;
        }
    }

    public Float getAsFloat(String key) {
        Object value = values.get(key);
        if (value == null) {
            return null;
        }
        if (value instanceof Float) {
            return (Float) value;
        }
        if (value instanceof Number) {
            return ((Number) value).floatValue();
        }
        try {
            return Float.parseFloat(value.toString());
        } catch (NumberFormatException e) {
            return null;
        }
    }

    public Double getAsDouble(String key) {
        Object value = values.get(key);
        if (value == null) {
            return null;
        }
        if (value instanceof Double) {
            return (Double) value;
        }
        if (value instanceof Number) {
            return ((Number) value).doubleValue();
        }
        try {
            return Double.parseDouble(value.toString());
        } catch (NumberFormatException e) {
            return null;
        }
    }

    public Boolean getAsBoolean(String key) {
        Object value = values.get(key);
        if (value == null) {
            return null;
        }
        if (value instanceof Boolean) {
            return (Boolean) value;
        }
        if (value instanceof Number) {
            return ((Number) value).intValue() != 0;
        }
        String s = value.toString();
        if ("true".equalsIgnoreCase(s) || "1".equals(s)) {
            return Boolean.TRUE;
        }
        if ("false".equalsIgnoreCase(s) || "0".equals(s)) {
            return Boolean.FALSE;
        }
        return null;
    }

    public byte[] getAsByteArray(String key) {
        Object value = values.get(key);
        return value instanceof byte[] ? (byte[]) value : null;
    }

    public Set<Map.Entry<String, Object>> valueSet() {
        return values.entrySet();
    }

    public Set<String> keySet() {
        return values.keySet();
    }

    public Map<String, Object> getValues() {
        return values;
    }

    private static Long getAsLongValue(Object value) {
        if (value == null) {
            return null;
        }
        if (value instanceof Long) {
            return (Long) value;
        }
        if (value instanceof Number) {
            return ((Number) value).longValue();
        }
        try {
            return Long.parseLong(value.toString());
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static Integer getAsIntegerValue(Object value) {
        if (value == null) {
            return null;
        }
        if (value instanceof Integer) {
            return (Integer) value;
        }
        if (value instanceof Number) {
            return ((Number) value).intValue();
        }
        try {
            return Integer.parseInt(value.toString());
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /** 与 Android 一致的可变列表视图（部分代码走这里读值） */
    public ArrayList<String> keyList() {
        return new ArrayList<String>(values.keySet());
    }
}
