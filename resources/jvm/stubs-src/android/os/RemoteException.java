package android.os;

/**
 * RemoteException stub —— Binder 调用失败异常。
 *
 * 桌面版无 Binder，任何抛此异常的路径都意味着「跨进程能力不可用」。
 * 做成 checked exception（与 Android 一致）以便反射调用时签名匹配。
 *
 * 注：Android 里它继承 android.util.AndroidException，这里直接继承 Exception，
 * 避免为桩类再拖入一个 AndroidException 依赖（catch 语义完全一致）。
 */
public class RemoteException extends Exception {

    public RemoteException() {
        super();
    }

    public RemoteException(String message) {
        super(message);
    }

    public RemoteException(String message, Throwable cause) {
        super(message, cause);
    }

    public RemoteException(Throwable cause) {
        super(cause);
    }
}
