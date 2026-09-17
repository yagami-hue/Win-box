package android.database.sqlite;

import android.database.Cursor;

/**
 * SQLiteCursorDriver stub —— 查询驱动。
 *
 * 桌面版不做真 SQLite：query() 返回 null（"无结果集"），
 * cursorClosed/cursorDeactivated 是空通知。
 */
public interface SQLiteCursorDriver {

    Cursor query(SQLiteDatabase.CursorFactory factory, String[] bindArgs);

    void cursorDeactivated();

    void cursorRequeried(Cursor cursor);

    void cursorClosed();

    void setBindArguments(String[] bindArgs);
}
