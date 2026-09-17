package android.database.sqlite;

/**
 * SQLiteQuery stub —— 预编译查询。
 *
 * 桌面版不做真 SQL：仅保存 SQL 文本，bind* 参数被忽略
 * （因为 SQLiteCursor 永远返回空集，绑定值不会被读到）。
 */
public class SQLiteQuery extends SQLiteProgram {

    private final String sql;

    public SQLiteQuery(SQLiteDatabase db, String query) {
        super(db, query, null, null);
        this.sql = query;
    }

    public String getSql() {
        return sql;
    }

    public int fillWindow(android.database.CursorWindow window, int startPos, int requiredPos,
                          boolean countAllRows) {
        return 0;
    }
}
