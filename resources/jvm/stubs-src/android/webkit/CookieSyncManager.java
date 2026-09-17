package android.webkit;

import android.content.Context;

/**
 * CookieSyncManager stub —— 旧版 cookie 持久化同步器（已废弃但仍有蜘蛛引用）。
 *
 * <p>桌面端无持久 cookie 库，所有方法 no-op。{@code getInstance()} 必须返回非 null，
 * 因为蜘蛛惯用 {@code CookieSyncManager.createInstance(ctx); ...getInstance().sync();}。
 */
@Deprecated
public class CookieSyncManager {

    private static CookieSyncManager sInstance;

    protected CookieSyncManager() {
    }

    public static CookieSyncManager createInstance(Context context) {
        if (sInstance == null) sInstance = new CookieSyncManager();
        return sInstance;
    }

    public static CookieSyncManager getInstance() {
        if (sInstance == null) sInstance = new CookieSyncManager();
        return sInstance;
    }

    public void sync() {
    }

    public void startSync() {
    }

    public void stopSync() {
    }

    public void resetSync() {
    }
}
