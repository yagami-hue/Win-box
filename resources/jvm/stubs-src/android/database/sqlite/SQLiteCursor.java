package android.database.sqlite;

import android.database.Cursor;

/**
 * SQLiteCursor stub —— SQLite 查询结果集。
 *
 * 桌面版无真 SQLite，因此这个游标永远"空"：
 * getCount()=0、moveToNext()=false，调用方自然走"无数据"分支。
 * close()/deactivate() 为空操作（无底层资源需要释放）。
 */
public class SQLiteCursor extends SQLiteClosable implements Cursor {

    private final SQLiteDatabase db;

    public SQLiteCursor(SQLiteDatabase db, SQLiteCursorDriver driver, String editTable, SQLiteQuery query) {
        this.db = db;
    }

    public SQLiteCursor(SQLiteCursorDriver driver, String editTable, SQLiteQuery query) {
        this(null, driver, editTable, query);
    }

    public SQLiteDatabase getDatabase() {
        return db;
    }

    public void setSelectionArguments(String[] selectionArgs) {
    }

    public void setWindow(android.database.CursorWindow window) {
    }

    // ---------------- Cursor：永久空结果集 ----------------

    @Override public int getCount() { return 0; }
    @Override public int getPosition() { return -1; }
    @Override public boolean moveToFirst() { return false; }
    @Override public boolean moveToNext() { return false; }
    @Override public boolean moveToPrevious() { return false; }
    @Override public boolean moveToPosition(int position) { return false; }
    @Override public boolean isFirst() { return false; }
    @Override public boolean isLast() { return false; }
    @Override public boolean isBeforeFirst() { return true; }
    @Override public boolean isAfterLast() { return true; }
    @Override public boolean isClosed() { return false; }
    @Override public boolean isNull() { return true; }
    @Override public int getColumnCount() { return 0; }
    @Override public String getColumnName(int columnIndex) { return null; }
    @Override public String[] getColumnNames() { return new String[0]; }
    @Override public int getColumnIndex(String columnName) { return -1; }
    @Override public int getColumnIndexOrThrow(String columnName) { return -1; }
    @Override public String getString(int columnIndex) { return null; }
    @Override public short getShort(int columnIndex) { return 0; }
    @Override public int getInt(int columnIndex) { return 0; }
    @Override public long getLong(int columnIndex) { return 0L; }
    @Override public float getFloat(int columnIndex) { return 0f; }
    @Override public double getDouble(int columnIndex) { return 0d; }
    @Override public byte[] getBlob(int columnIndex) { return null; }
    @Override public boolean isNull(int columnIndex) { return true; }
    @Override public int getType(int columnIndex) { return 0; }
    @Override public void deactivate() { }
    @Override public void close() { }
    @Override public int getInt() { return 0; }
    @Override public String getString() { return null; }
}
