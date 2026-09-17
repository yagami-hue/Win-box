package android.os;

/**
 * Parcel stub —— Android 的序列化容器。
 *
 * ★ 桌面版无 Binder 传输，这里做**内存型**实现（单一字节缓冲 + 读游标），
 *   保证 read/write 成对调用不炸：AIDL 生成的 marshall/unmarshall
 *   代码在某些蜘蛛里会真的执行。
 *
 * 设计要点：
 * - 单一 `buf` 既作写入目标也作读取来源（避免以前 write/read 用两套缓冲
 *   导致 obtain() 后写完立刻读读到空的问题）
 * - 数值一律小端（与 Android Parcel 一致）
 * - 越界读返回零值/ null，绝不抛异常（桩类原则：不因缺能力打断主流程）
 */
public class Parcel {

    private java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
    private byte[] data = new byte[0];
    private int readPos = 0;
    private String interfaceName = null;

    private Parcel() {
    }

    public static Parcel obtain() {
        return new Parcel();
    }

    public void recycle() {
        // 桌面版无池化，保留内容以便调用方继续读取
    }

    // ---------------- 缓冲同步 ----------------

    /** 把写入缓冲刷新到可读字节数组（幂等） */
    private void syncOut() {
        data = out.toByteArray();
    }

    /** 通过 marshall 交给对方 unmarshall 后，从外部字节装载 */
    private void resetOutFrom(byte[] src, int offset, int length) {
        byte[] copy = new byte[length];
        System.arraycopy(src, offset, copy, 0, length);
        this.data = copy;
        this.out = new java.io.ByteArrayOutputStream();
        this.out.write(copy, 0, copy.length);
    }

    public byte[] marshall() {
        syncOut();
        return data;
    }

    public void unmarshall(byte[] src, int offset, int length) {
        if (src == null || offset < 0 || length < 0 || offset + length > src.length) {
            return;
        }
        resetOutFrom(src, offset, length);
        readPos = 0;
    }

    public static void setDataSize(long size) {
    }

    public static long getDataSize() {
        return 0;
    }

    public void setDataPosition(int pos) {
        this.readPos = Math.max(0, pos);
    }

    public int dataPosition() {
        return readPos;
    }

    public int dataSize() {
        syncOut();
        return data.length;
    }

    public int dataAvail() {
        syncOut();
        return Math.max(0, data.length - readPos);
    }

    // ---------------- int ----------------

    public void writeInt(int value) {
        out.write(value & 0xff);
        out.write((value >>> 8) & 0xff);
        out.write((value >>> 16) & 0xff);
        out.write((value >>> 24) & 0xff);
        syncOut();
    }

    public int readInt() {
        syncOut();
        if (readPos + 4 > data.length) {
            return 0;
        }
        int v = (data[readPos] & 0xff)
                | ((data[readPos + 1] & 0xff) << 8)
                | ((data[readPos + 2] & 0xff) << 16)
                | ((data[readPos + 3] & 0xff) << 24);
        readPos += 4;
        return v;
    }

    // ---------------- long ----------------

    public void writeLong(long value) {
        for (int i = 0; i < 8; i++) {
            out.write((int) ((value >>> (i * 8)) & 0xff));
        }
        syncOut();
    }

    public long readLong() {
        long v = 0;
        for (int i = 0; i < 8; i++) {
            v |= ((long) readRawByte()) << (i * 8);
        }
        return v;
    }

    // ---------------- float / double ----------------

    public void writeFloat(float value) {
        writeInt(Float.floatToIntBits(value));
    }

    public float readFloat() {
        return Float.intBitsToFloat(readInt());
    }

    public void writeDouble(double value) {
        writeLong(Double.doubleToLongBits(value));
    }

    public double readDouble() {
        return Double.longBitsToDouble(readLong());
    }

    // ---------------- String ----------------

    public void writeString(String value) {
        if (value == null) {
            writeInt(-1);
            return;
        }
        byte[] b = value.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        writeInt(b.length);
        out.write(b, 0, b.length);
        syncOut();
    }

    public String readString() {
        int len = readInt();
        if (len < 0) {
            return null;
        }
        syncOut();
        if (readPos + len > data.length) {
            return null;
        }
        String s = new String(data, readPos, len, java.nio.charset.StandardCharsets.UTF_8);
        readPos += len;
        return s;
    }

    public void writeStringArray(String[] val) {
        if (val == null) {
            writeInt(-1);
            return;
        }
        writeInt(val.length);
        for (String s : val) {
            writeString(s);
        }
    }

    public String[] createStringArray() {
        int n = readInt();
        if (n < 0) {
            return null;
        }
        String[] arr = new String[n];
        for (int i = 0; i < n; i++) {
            arr[i] = readString();
        }
        return arr;
    }

    // ---------------- byte[] ----------------

    public void writeByteArray(byte[] b) {
        if (b == null) {
            writeInt(-1);
            return;
        }
        writeInt(b.length);
        out.write(b, 0, b.length);
        syncOut();
    }

    public byte[] createByteArray() {
        int len = readInt();
        if (len < 0) {
            return null;
        }
        syncOut();
        if (readPos + len > data.length) {
            return null;
        }
        byte[] outArr = new byte[len];
        System.arraycopy(data, readPos, outArr, 0, len);
        readPos += len;
        return outArr;
    }

    public void writeByte(byte value) {
        out.write(value & 0xff);
        syncOut();
    }

    public byte readByte() {
        return (byte) readRawByte();
    }

    // ---------------- Binder 相关（无实际操作） ----------------

    public void writeInterfaceToken(String name) {
        this.interfaceName = name;
    }

    public void enforceInterface(String name) {
        // 桌面版不做校验（真实 Android 校验失败会抛 SecurityException）
    }

    public void writeException(Exception e) {
    }

    public void readException() {
    }

    public void writeNoException() {
    }

    public void writeStrongBinder(IBinder binder) {
    }

    public IBinder readStrongBinder() {
        return null;
    }

    public void writeParcelable(Parcelable p, int flags) {
    }

    public <T extends Parcelable> T readParcelable(ClassLoader loader) {
        return null;
    }

    public void writeValue(Object o) {
    }

    public Object readValue(ClassLoader loader) {
        return null;
    }

    public void writeList(java.util.List list) {
    }

    public java.util.ArrayList readArrayList(ClassLoader loader) {
        return new java.util.ArrayList();
    }

    public void writeMap(java.util.Map map) {
    }

    public java.util.HashMap readHashMap(ClassLoader loader) {
        return new java.util.HashMap();
    }

    public void writeBundle(Bundle b) {
    }

    public Bundle readBundle(ClassLoader loader) {
        return null;
    }

    // ---------------- 内部 ----------------

    private int readRawByte() {
        syncOut();
        if (readPos >= data.length) {
            return 0;
        }
        return data[readPos++] & 0xff;
    }

    @Override
    public String toString() {
        return "Parcel(dataSize=" + dataSize() + ", dataPosition=" + readPos + ")";
    }
}
