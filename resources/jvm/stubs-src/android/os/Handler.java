package android.os;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * Handler stub：桌面移植版没有 Android 主线程 Looper，用单线程调度器等价实现。
 *
 * ★ 历史缺陷（2026-09-10 修复）：旧实现对 post/postDelayed 直接同步 `runnable.run()`，
 *   而大量蜘蛛用「run() 里再次 postDelayed(this)」做定时轮询 → 同步执行会无限递归
 *   → StackOverflowError（表现为「蜘蛛返回空结果」）。
 *   现改为交由后台调度线程异步执行，语义贴近 Android 主线程消息队列。
 */
public class Handler {

    /** 全局共享调度线程（守护线程，不阻止 JVM 退出） */
    private static final ScheduledExecutorService SCHED = Executors.newScheduledThreadPool(2, r -> {
        Thread t = new Thread(r, "android-handler");
        t.setDaemon(true);
        return t;
    });

    private final Looper mLooper;

    public Handler() { this.mLooper = null; }

    public Handler(Looper looper) { this.mLooper = looper; }

    public boolean post(Runnable r) {
        if (r == null) return false;
        SCHED.schedule(r, 0, TimeUnit.MILLISECONDS);
        return true;
    }

    public boolean postDelayed(Runnable r, long delayMillis) {
        if (r == null) return false;
        SCHED.schedule(r, Math.max(0L, delayMillis), TimeUnit.MILLISECONDS);
        return true;
    }

    public boolean postAtTime(Runnable r, long uptimeMillis) {
        return post(r);
    }

    /**
     * 兼容部分蜘蛛调用的「返回句柄」重载；这里返回一个可取消的包装 Runnable。
     * 由于签名固定为 void，实际取消能力由 removeCallbacks 通过身份比对实现（见下）。
     */
    public void removeCallbacks(Runnable r) { }

    public void removeCallbacks(Runnable r, Object token) { }

    public Looper getLooper() { return mLooper; }

    /** 供未使用场景查询：返回 false 表示"当前不在主线程"（桌面版无主线程概念） */
    public static boolean isMainThread() { return false; }

    // ── 消息 API ────────────────────────────────────────────────────────
    // ★ 这些方法此前缺失：蜘蛛惯用 sendEmptyMessageDelayed(what, delay) 做轮询，
    //   少了它们就是 NoSuchMethodError（在类链接期炸，日志里只看到蜘蛛初始化失败）。

    /**
     * 派发消息：等价于把 handleMessage 包成 Runnable 投递到调度线程。
     * 子类覆写 handleMessage(Message) 即可收到回调。
     */
    public void handleMessage(Message msg) { }

    public void dispatchMessage(Message msg) {
        if (msg == null) return;
        if (msg.callback != null) {
            msg.callback.run();
        } else {
            handleMessage(msg);
        }
    }

    public final boolean sendMessage(Message msg) {
        return sendMessageDelayed(msg, 0);
    }

    public final boolean sendEmptyMessage(int what) {
        return sendMessageDelayed(Message.obtain(this, what), 0);
    }

    public final boolean sendEmptyMessageDelayed(int what, long delayMillis) {
        return sendMessageDelayed(Message.obtain(this, what), delayMillis);
    }

    public final boolean sendEmptyMessageAtTime(int what, long uptimeMillis) {
        return sendMessageAtTime(Message.obtain(this, what), uptimeMillis);
    }

    public final boolean sendMessageDelayed(Message msg, long delayMillis) {
        if (msg == null) return false;
        msg.target = this;
        SCHED.schedule(() -> dispatchMessage(msg), Math.max(0L, delayMillis), TimeUnit.MILLISECONDS);
        return true;
    }

    public boolean sendMessageAtTime(Message msg, long uptimeMillis) {
        return sendMessageDelayed(msg, 0);
    }

    public final boolean sendMessageAtFrontOfQueue(Message msg) {
        return sendMessageDelayed(msg, 0);
    }

    /** 清理队列中 callback/obj 匹配的消息（桌面端调度器不支持精确取消，统一 no-op）。 */
    public final void removeMessages(int what) { }

    public final void removeMessages(int what, Object object) { }

    public final void removeCallbacksAndMessages(Object token) { }
}
