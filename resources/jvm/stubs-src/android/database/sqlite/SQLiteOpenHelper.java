package android.database.sqlite;

import android.content.Context;
import android.database.DatabaseErrorHandler;

/**
 * SQLiteOpenHelper stub —— Room 初始化时最常见的入口。
 *
 * ★ 关键语义：`getWritableDatabase()` / `getReadableDatabase()` 必须
 *   **返回一个非 null 的 SQLiteDatabase**，否则 Room 生成的
 *   AppDatabase_Impl 会在拿到 null 后立刻 NPE，错误信息反而更难定位。
 *   这里返回"空库"实例，使 Room 走到「查询无数据」分支。
 *
 *   onCreate/onUpgrade 由构造方实现，但不会被本桩触发
 *   （因为不做真实 schema 管理）。若某源强依赖建表，会在写操作时
 *   抛带明确文案的 SQLiteException，日志可见。
 */
public abstract class SQLiteOpenHelper {

    private final Context context;
    private final String name;
    private final int version;
    private SQLiteDatabase database = null;

    public SQLiteOpenHelper(Context context, String name, SQLiteDatabase.CursorFactory factory, int version) {
        this.context = context;
        this.name = name == null ? ":memory:" : name;
        this.version = version <= 0 ? 1 : version;
    }

    public SQLiteOpenHelper(Context context, String name, SQLiteDatabase.CursorFactory factory, int version,
                            DatabaseErrorHandler errorHandler) {
        this(context, name, factory, version);
    }

    public String getDatabaseName() {
        return name;
    }

    public synchronized SQLiteDatabase getWritableDatabase() {
        if (database == null) {
            database = SQLiteDatabase.openOrCreateDatabase(name, null);
            // onCreate/onUpgrade 空实现（子类覆写），不主动调用以避免建表失败干扰主流程
        }
        return database;
    }

    public synchronized SQLiteDatabase getReadableDatabase() {
        return getWritableDatabase();
    }

    public synchronized void close() {
        if (database != null) {
            database.close();
            database = null;
        }
    }

    public void onConfigure(SQLiteDatabase db) {
    }

    public abstract void onCreate(SQLiteDatabase db);

    public abstract void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion);

    public void onDowngrade(SQLiteDatabase db, int oldVersion, int newVersion) {
    }

    public void onOpen(SQLiteDatabase db) {
    }

    public synchronized void setWriteAheadLoggingEnabled(boolean enabled) {
    }
}
