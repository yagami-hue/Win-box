package androidx.room;

import android.os.IBinder;

/**
 * MultiInstanceInvalidationService stub —— Room 多进程失效通知服务。
 *
 * ★ 扫描确认：**只有混淆工具库**（com.github.catvod.spider.merge.*，≈ shadow 版
 *   OkHttp/Gson）引用它，点播主链路（房数据库初始化）并不触达。
 *   因此这里只保证：类可加载 + 内部接口可加载 + 方法签名齐全，不做任何实际逻辑。
 *
 * 真实 Room 场景下这是个 android.app.Service 子类；桌面版无 Service 体系，
 * 这里只留最小骨架，保证 Class.forName 与反射调用不炸。
 */
public class MultiInstanceInvalidationService {

    public MultiInstanceInvalidationService() {
    }

    public IBinder onBind(android.content.Intent intent) {
        return null;
    }

    public boolean onUnbind(android.content.Intent intent) {
        return false;
    }

    public void onCreate() {
    }

    public void onDestroy() {
    }

    /**
     * 失效通知回调 —— Room 生成的 IMultiInstanceInvalidationCallback 桩。
     * 桌面版无跨进程回调，方法体为空。
     */
    public interface IMultiInstanceInvalidationCallback {
        void onInvalidation(String[] tables);

        IBinder asBinder();
    }

    /**
     * 失效通知服务端 —— Room 生成的 IMultiInstanceInvalidationService 桩。
     */
    public interface IMultiInstanceInvalidationService {
        int registerClient(IMultiInstanceInvalidationCallback callback, String name);

        void unregisterClient(int clientId);

        void broadcastInvalidation(int clientId, String[] tables);

        IBinder asBinder();
    }
}
