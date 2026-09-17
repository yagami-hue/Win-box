package android.database.sqlite;

import android.database.Cursor;
import android.database.DatabaseErrorHandler;

/**
 * SQLiteDatabase stub —— 最小可加载实现。
 *
 * ★ 为什么不做成"真能用"的 SQLite？
 *   桌面 JVM 桥不带 sqlite-jdbc（会引入额外 3~5MB 原生库并需按平台分发）。
 *   而本移植的定位是"点播取流"，蜘蛛用数据库的场景几乎都是**缓存 token / 播放历史**，
 *   属于可降级能力。因此这里：
 *   - 类可加载（消除 ClassNotFoundException）
 *   - open* 返回一个"已关闭"的空库实例，使调用方走到"查不到数据"分支
 *   - 真正的写操作抛 SQLiteException 并带明确文案，便于日志定位而不是静默失败
 *
 * 若将来某源强依赖持久化，再评估引入 sqlite-jdbc。
 */
public class SQLiteDatabase extends SQLiteClosable {

    private final String path;
    private boolean open = true;

    private SQLiteDatabase(String path) {
        this.path = path == null ? ":memory:" : path;
    }

    // ---------------- 打开 / 关闭 ----------------

    public static SQLiteDatabase openDatabase(String path, CursorFactory factory, int flags) {
        return new SQLiteDatabase(path);
    }

    public static SQLiteDatabase openDatabase(String path, CursorFactory factory, int flags, DatabaseErrorHandler errorHandler) {
        return new SQLiteDatabase(path);
    }

    public static SQLiteDatabase openOrCreateDatabase(String path, CursorFactory factory) {
        return new SQLiteDatabase(path);
    }

    public static SQLiteDatabase openOrCreateDatabase(java.io.File file, CursorFactory factory) {
        return new SQLiteDatabase(file == null ? null : file.getAbsolutePath());
    }

    public static SQLiteDatabase openOrCreateDatabase(String path, CursorFactory factory, DatabaseErrorHandler errorHandler) {
        return new SQLiteDatabase(path);
    }

    public static SQLiteDatabase create(CursorFactory factory) {
        return new SQLiteDatabase(":memory:");
    }

    public boolean isOpen() { return open; }

    public boolean isReadOnly() { return true; }

    public String getPath() { return path; }

    @Override
    public void close() {
        open = false;
        super.close();
    }

    // ---------------- 查询（返回空结果集，语义 = 无数据） ----------------

    public Cursor rawQuery(String sql, String[] selectionArgs) {
        return new EmptyCursor();
    }

    public Cursor rawQuery(String sql, String[] selectionArgs, android.os.CancellationSignal cancellationSignal) {
        return new EmptyCursor();
    }

    public Cursor query(String table, String[] columns, String selection, String[] selectionArgs,
                        String groupBy, String having, String orderBy) {
        return new EmptyCursor();
    }

    public Cursor query(String table, String[] columns, String selection, String[] selectionArgs,
                        String groupBy, String having, String orderBy, String limit) {
        return new EmptyCursor();
    }

    public Cursor query(boolean distinct, String table, String[] columns, String selection, String[] selectionArgs,
                        String groupBy, String having, String orderBy, String limit) {
        return new EmptyCursor();
    }

    public Cursor query(boolean distinct, String table, String[] columns, String selection, String[] selectionArgs,
                        String groupBy, String having, String orderBy, String limit,
                        android.os.CancellationSignal cancellationSignal) {
        return new EmptyCursor();
    }

    public Cursor queryWithFactory(CursorFactory cursorFactory, boolean distinct, String table, String[] columns,
                                   String selection, String[] selectionArgs, String groupBy, String having,
                                   String orderBy, String limit) {
        return new EmptyCursor();
    }

    // ---------------- 执行 ----------------

    /**
     * 写操作：桌面版无持久化。抛异常而非静默丢弃，避免蜘蛛以为写成功而在后续读到不一致状态。
     */
    public void execSQL(String sql) {
        throw new SQLiteException("桌面移植版未内置 SQLite，无法执行写操作：" + sql);
    }

    public void execSQL(String sql, Object[] bindArgs) {
        throw new SQLiteException("桌面移植版未内置 SQLite，无法执行写操作：" + sql);
    }

    public SQLiteStatement compileStatement(String sql) {
        throw new SQLiteException("桌面移植版未内置 SQLite，无法编译语句：" + sql);
    }

    public int delete(String table, String whereClause, String[] whereArgs) {
        throw new SQLiteException("桌面移植版未内置 SQLite，无法执行删除：" + table);
    }

    public long insert(String table, String nullColumnHack, android.content.ContentValues values) {
        throw new SQLiteException("桌面移植版未内置 SQLite，无法执行插入：" + table);
    }

    public long insertOrThrow(String table, String nullColumnHack, android.content.ContentValues values) {
        throw new SQLiteException("桌面移植版未内置 SQLite，无法执行插入：" + table);
    }

    public int update(String table, android.content.ContentValues values, String whereClause, String[] whereArgs) {
        throw new SQLiteException("桌面移植版未内置 SQLite，无法执行更新：" + table);
    }

    // ---------------- 事务（空实现，保证不因"未开启事务"报错） ----------------

    public void beginTransaction() { }

    public void beginTransactionNonExclusive() { }

    public void endTransaction() { }

    public void setTransactionSuccessful() { }

    public boolean inTransaction() { return false; }

    // ---------------- 版本号 ----------------

    public int getVersion() { return 0; }

    public void setVersion(int version) { }

    public long getMaximumSize() { return 0; }

    public long setMaximumSize(long numBytes) { return numBytes; }

    public void setLocale(java.util.Locale locale) { }

    public void setLockingEnabled(boolean lockingEnabled) { }

    public void disableWriteAheadLogging() { }

    public boolean enableWriteAheadLogging() { return false; }

    public boolean isWriteAheadLoggingEnabled() { return false; }

    // ---------------- 内部：空结果集 ----------------

    /** 永远返回 0 行的 Cursor —— 等价于"表里没有数据"，是桌面版最安全的语义 */
    public static class EmptyCursor implements Cursor {
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
        @Override public void close() { }
        @Override public boolean isClosed() { return false; }
        @Override public boolean isNull() { return true; }
        @Override public void deactivate() { }
        @Override public int getInt() { return 0; }
        @Override public String getString() { return null; }
    }

    /** CursorFactory stub —— 与 android.database.sqlite.CursorFactory 同包，供 open* 签名使用 */
    public interface CursorFactory {
        Cursor newCursor(SQLiteDatabase db, SQLiteCursorDriver masterQuery, String editTable, SQLiteQuery query);
    }
}
