package android.database.sqlite;

/**
 * SQLiteException stub —— 数据库异常类型。空壳即可（继承 RuntimeException），
 * 蜘蛛代码里通常 catch 它做降级；桌面版不会真的抛。
 */
public class SQLiteException extends RuntimeException {
    public SQLiteException() { super(); }
    public SQLiteException(String error) { super(error); }
    public SQLiteException(String error, Throwable cause) { super(error, cause); }
}
