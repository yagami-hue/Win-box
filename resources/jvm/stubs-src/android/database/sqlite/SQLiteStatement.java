package android.database.sqlite;

/**
 * SQLiteStatement stub —— 预编译的可执行语句。
 *
 * ★ 与 SQLiteDatabase.execSQL 保持同一策略：
 *   执行类方法（execute*）抛 SQLiteException 并带明确中文文案，
 *   避免"静默成功但没写入"导致后续读到不一致状态。
 */
public class SQLiteStatement extends SQLiteProgram {

    private final String sql;

    public SQLiteStatement(SQLiteDatabase db, String sql) {
        super(db, sql, null, null);
        this.sql = sql;
    }

    public void execute() {
        throw new SQLiteException("桌面移植版未内置 SQLite，无法执行语句：" + sql);
    }

    public int executeUpdateDelete() {
        throw new SQLiteException("桌面移植版未内置 SQLite，无法执行语句：" + sql);
    }

    public long executeInsert() {
        throw new SQLiteException("桌面移植版未内置 SQLite，无法执行插入：" + sql);
    }

    public long simpleQueryForLong() {
        return 0L;
    }

    public String simpleQueryForString() {
        return null;
    }

    public String toString() {
        return "SQLiteProgram: " + sql;
    }
}
