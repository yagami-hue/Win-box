package android.database.sqlite;

import android.content.ContentValues;

/**
 * SQLiteProgram stub —— 预编译语句基类（SQLiteQuery / SQLiteStatement 的父类）。
 *
 * 桌面版不做真 SQL：绑定参数只做"接受但忽略"处理，
 * 因为下游 SQLiteCursor 永远返回空集，绑定值不会被读到。
 */
public abstract class SQLiteProgram extends SQLiteClosable {

    protected final SQLiteDatabase mDatabase;
    protected final String mSql;
    protected final Object[] mBindArgs;
    private boolean mReadOnly = false;

    SQLiteProgram(SQLiteDatabase db, String sql, Object[] bindArgs, CancellationSignalArg cancellationSignal) {
        this.mDatabase = db;
        this.mSql = sql;
        this.mBindArgs = bindArgs == null ? new Object[0] : bindArgs;
    }

    SQLiteProgram(SQLiteDatabase db, String sql) {
        this(db, sql, null, null);
    }

    public void bindNull(int index) { setBindArg(index, null); }

    public void bindLong(int index, long value) { setBindArg(index, Long.valueOf(value)); }

    public void bindDouble(int index, double value) { setBindArg(index, Double.valueOf(value)); }

    public void bindString(int index, String value) { setBindArg(index, value); }

    public void bindBlob(int index, byte[] value) { setBindArg(index, value); }

    public void bindAllArgsAsStrings(String[] bindArgs) {
        // 空实现：绑定参数不影响空结果集
    }

    public void clearBindings() {
    }

    public String getSql() {
        return mSql;
    }

    public boolean isReadOnly() {
        return mReadOnly;
    }

    public void setReadOnly(boolean readOnly) {
        this.mReadOnly = readOnly;
    }

    private void setBindArg(int index, Object value) {
        // 越界索引静默忽略 —— 绑定失败不该打断主流程
        if (index >= 0 && index < mBindArgs.length) {
            mBindArgs[index] = value;
        }
    }

    @Override
    public String toString() {
        return mSql == null ? "" : mSql;
    }

    /** 占位类型：与 SQLiteDatabase.CancellationSignalArg 对应（真正的 CancellationSignal 在 android.os） */
    public static class CancellationSignalArg { }
}
