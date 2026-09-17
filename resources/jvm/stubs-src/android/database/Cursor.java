package android.database;

/**
 * Cursor stub：桌面 JVM 桥无真实 SQLite，用内存行集做最小可用实现。
 *
 * ★ 2026-09-10 第四轮修复：`android.database` 整包此前缺失，导致
 *   `ClassNotFoundException: android.database.Cursor`（案例：Token.jar 的
 *   csp_KungFu404 → Ali.init → room.AppDatabase 初始化）。
 *
 * 设计取舍：
 * - `Cursor` 在 Room 生成的代码里主要作为**返回类型**出现，实际调用面很窄
 *   （反编译 AppDatabase_Impl 确认只有 `close()`）。因此这里给一个"空结果集"语义：
 *   getCount()=0、moveToNext()=false —— 表不存在等价于查不到数据，
 *   蜘蛛随后走"无缓存 → 重新拉取"分支，是**正确**的业务行为，不会脏读。
 * - 若将来某源真的写库，可通过子类覆盖；此处不臆造真实 SQLite。
 */
public interface Cursor {

    int getCount();

    int getPosition();

    boolean moveToFirst();

    boolean moveToNext();

    boolean moveToPrevious();

    boolean moveToPosition(int position);

    boolean isFirst();

    boolean isLast();

    boolean isBeforeFirst();

    boolean isAfterLast();

    int getColumnCount();

    String getColumnName(int columnIndex);

    String[] getColumnNames();

    int getColumnIndex(String columnName);

    int getColumnIndexOrThrow(String columnName);

    String getString(int columnIndex);

    short getShort(int columnIndex);

    int getInt(int columnIndex);

    long getLong(int columnIndex);

    float getFloat(int columnIndex);

    double getDouble(int columnIndex);

    byte[] getBlob(int columnIndex);

    boolean isNull(int columnIndex);

    int getType(int columnIndex);

    void close();

    boolean isClosed();

    boolean isNull();

    void deactivate();

    int getInt();

    String getString();
}
