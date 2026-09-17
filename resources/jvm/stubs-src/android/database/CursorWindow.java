package android.database;

/**
 * CursorWindow stub —— 游标数据窗口（Android 里是 native 内存块）。
 *
 * 桌面版无 native 游标窗口：只作为类型存在，所有读返回空。
 */
public class CursorWindow implements android.os.Parcelable {

    private final String name;
    private int startPosition = 0;
    private int numRows = 0;
    private int numColumns = 0;

    public CursorWindow(String name) {
        this.name = name == null ? "" : name;
    }

    public CursorWindow(boolean localWindow) {
        this(null);
    }

    public String getName() {
        return name;
    }

    public int getStartPosition() {
        return startPosition;
    }

    public void setStartPosition(int position) {
        this.startPosition = position;
    }

    public int getNumRows() {
        return numRows;
    }

    public int getNumColumns() {
        return numColumns;
    }

    public void clear() {
        numRows = 0;
    }

    public void close() {
    }

    public boolean isClosed() {
        return false;
    }

    public boolean isNull(int row, int column) {
        return true;
    }

    public String getString(int row, int column) {
        return null;
    }

    public int getInt(int row, int column) {
        return 0;
    }

    public long getLong(int row, int column) {
        return 0L;
    }

    public short getShort(int row, int column) {
        return 0;
    }

    public float getFloat(int row, int column) {
        return 0f;
    }

    public double getDouble(int row, int column) {
        return 0d;
    }

    public byte[] getBlob(int row, int column) {
        return null;
    }

    public int getType(int row, int column) {
        return 0;
    }

    public static CursorWindow newFromParcel(android.os.Parcel p) {
        return new CursorWindow(false);
    }

    @Override
    public int describeContents() {
        return 0;
    }

    @Override
    public void writeToParcel(android.os.Parcel dest, int flags) {
    }

    public static final Creator<CursorWindow> CREATOR = new Creator<CursorWindow>() {
        @Override
        public CursorWindow createFromParcel(android.os.Parcel source) {
            return new CursorWindow(false);
        }

        @Override
        public CursorWindow[] newArray(int size) {
            return new CursorWindow[size];
        }
    };
}
