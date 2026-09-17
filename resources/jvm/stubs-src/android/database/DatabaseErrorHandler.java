package android.database;

/**
 * DatabaseErrorHandler stub —— SQLiteDatabase 的构造参数类型。
 * Room/SupportSQLite 在打开库时按名引用它；桌面版无真实 SQLite，仅需类型存在。
 */
public interface DatabaseErrorHandler {
    void onCorruption(android.database.sqlite.SQLiteDatabase dbObj);
}
