package android.util;

import java.util.Arrays;

/**
 * SparseIntArray stub —— int→int 映射（Android 为省内存用双数组实现）。
 *
 * ★ 纯数据结构：必须功能完整。这里用真实数组实现稀疏映射，
 *   保证 get() / put() / size() 语义正确（空壳会让业务读到恒 0）。
 */
public class SparseIntArray implements Cloneable {

    private int[] mKeys;
    private int[] mValues;
    private int mSize;

    public SparseIntArray() {
        this(10);
    }

    public SparseIntArray(int initialCapacity) {
        if (initialCapacity == 0) {
            initialCapacity = 1;
        }
        mKeys = new int[initialCapacity];
        mValues = new int[initialCapacity];
        mSize = 0;
    }

    @Override
    public SparseIntArray clone() {
        SparseIntArray copy = new SparseIntArray(mSize);
        copy.mSize = mSize;
        copy.mKeys = Arrays.copyOf(mKeys, mSize);
        copy.mValues = Arrays.copyOf(mValues, mSize);
        return copy;
    }

    /** 二分查找；返回下标或按位取反的插入点（与 Android 一致） */
    private int binarySearch(int key) {
        int lo = 0;
        int hi = mSize - 1;
        while (lo <= hi) {
            final int mid = (lo + hi) >>> 1;
            final int midVal = mKeys[mid];
            if (midVal < key) {
                lo = mid + 1;
            } else if (midVal > key) {
                hi = mid - 1;
            } else {
                return mid;
            }
        }
        return ~lo;
    }

    public int get(int key) {
        return get(key, 0);
    }

    public int get(int key, int valueIfKeyNotFound) {
        int i = binarySearch(key);
        if (i < 0) {
            return valueIfKeyNotFound;
        }
        return mValues[i];
    }

    public void delete(int key) {
        int i = binarySearch(key);
        if (i >= 0) {
            removeAt(i);
        }
    }

    public void removeAt(int index) {
        System.arraycopy(mKeys, index + 1, mKeys, index, mSize - (index + 1));
        System.arraycopy(mValues, index + 1, mValues, index, mSize - (index + 1));
        mSize--;
    }

    public void put(int key, int value) {
        int i = binarySearch(key);
        if (i >= 0) {
            mValues[i] = value;
        } else {
            i = ~i;
            if (mSize >= mKeys.length) {
                int n = Math.max(mSize + 1, mKeys.length * 2);
                mKeys = Arrays.copyOf(mKeys, n);
                mValues = Arrays.copyOf(mValues, n);
            }
            System.arraycopy(mKeys, i, mKeys, i + 1, mSize - i);
            System.arraycopy(mValues, i, mValues, i + 1, mSize - i);
            mKeys[i] = key;
            mValues[i] = value;
            mSize++;
        }
    }

    public int size() {
        return mSize;
    }

    public int keyAt(int index) {
        return mKeys[index];
    }

    public int valueAt(int index) {
        return mValues[index];
    }

    public void setValueAt(int index, int value) {
        mValues[index] = value;
    }

    public int indexOfKey(int key) {
        return binarySearch(key);
    }

    public int indexOfValue(int value) {
        for (int i = 0; i < mSize; i++) {
            if (mValues[i] == value) {
                return i;
            }
        }
        return -1;
    }

    public void clear() {
        mSize = 0;
    }

    public void append(int key, int value) {
        if (mSize != 0 && key <= mKeys[mSize - 1]) {
            put(key, value);
            return;
        }
        if (mSize >= mKeys.length) {
            int n = Math.max(mSize + 1, mKeys.length * 2);
            mKeys = Arrays.copyOf(mKeys, n);
            mValues = Arrays.copyOf(mValues, n);
        }
        mKeys[mSize] = key;
        mValues[mSize] = value;
        mSize++;
    }

    @Override
    public String toString() {
        if (size() <= 0) {
            return "{}";
        }
        StringBuilder buffer = new StringBuilder(mSize * 28);
        buffer.append('{');
        for (int i = 0; i < mSize; i++) {
            if (i > 0) {
                buffer.append(", ");
            }
            buffer.append(keyAt(i));
            buffer.append('=');
            buffer.append(valueAt(i));
        }
        buffer.append('}');
        return buffer.toString();
    }
}
