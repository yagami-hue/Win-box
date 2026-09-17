package android.os;

/**
 * CancellationSignal stub —— 查询取消信号。
 *
 * SQLiteDatabase.rawQuery 的第三参就是它，Room 也用它。
 * 桌面版无异步取消机制：所有状态查询返回「未取消」，
 * setOnCancelListener 只记录引用不触发（避免误杀正在执行的查询）。
 */
public class CancellationSignal {

    private volatile boolean cancelled = false;
    private OnCancelListener listener = null;

    public CancellationSignal() {
    }

    public boolean isCanceled() {
        return cancelled;
    }

    public void throwIfCanceled() {
        // 桌面版永不取消 —— 保持与 isCanceled() 一致的语义
    }

    public void cancel() {
        cancelled = true;
        OnCancelListener l = listener;
        if (l != null) {
            l.onCancel();
        }
    }

    public void setOnCancelListener(OnCancelListener listener) {
        this.listener = listener;
    }

    public interface OnCancelListener {
        void onCancel();
    }
}
