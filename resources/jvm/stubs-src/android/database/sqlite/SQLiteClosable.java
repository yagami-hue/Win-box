package android.database.sqlite;

/**
 * SQLiteClosable stub —— SQLiteProgram / SQLiteDatabase 的共同基类。
 * acquireReference/releaseReference 是 Android 连接池的引用计数；桌面版空实现。
 */
public abstract class SQLiteClosable implements java.io.Closeable {

    private int referenceCount = 1;

    protected void onAllReferencesReleased() { }

    protected void onAllReferencesReleasedFromContainer() { }

    public void acquireReference() { referenceCount++; }

    public void releaseReference() {
        referenceCount--;
        if (referenceCount <= 0) onAllReferencesReleased();
    }

    public void releaseReferenceFromContainer() {
        referenceCount--;
        if (referenceCount <= 0) onAllReferencesReleasedFromContainer();
    }

    public void close() { releaseReference(); }
}
