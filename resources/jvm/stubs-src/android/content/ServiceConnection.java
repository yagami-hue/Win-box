package android.content;

/**
 * ServiceConnection stub —— 绑定 Service 的回调。
 *
 * 桌面版无 Service 体系，此接口只作为签名存在（Context.bindService 的参数）。
 * 桩实现不主动回调，蜘蛛若依赖 onServiceConnected 拿 Binder 会拿到 null，
 * 但那属于「源本身依赖 Android 组件」的能力缺口，会由引擎侧日志明确暴露。
 */
public interface ServiceConnection {

    void onServiceConnected(ComponentName name, android.os.IBinder service);

    void onServiceDisconnected(ComponentName name);

    default void onBindingDied(ComponentName name) {
    }

    default void onNullBinding(ComponentName name) {
    }
}
