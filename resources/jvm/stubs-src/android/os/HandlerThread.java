package android.os;

/**
 * HandlerThread stub —— ★ 2026-09-27 新补（真机取证：解密 dex 里打包的 picasso
 *   `Dispatcher` 直接 `new HandlerThread("Picasso-Dispatcher")` 并 `start()`；
 *   缺类时整条图片/请求线程池初始化失败）。
 *
 * <p>桌面版没有 Looper：本实现是一个**真实线程**（延续 android.os.Handler 的调度模型：
 * 消息交给 Handler 的共享调度器执行），`getLooper()` 返回同一进程里的 Looper 单例
 * （见 Looper.getMainLooper()），保证 `new Handler(thread.getLooper())` 能用。
 */
public class HandlerThread extends Thread {

    private final String name;
    private Looper looper;

    public HandlerThread(String name) {
        super(name == null ? "HandlerThread" : name);
        this.name = name;
        setDaemon(true);
    }

    public HandlerThread(String name, int priority) {
        this(name);
        setPriority(priority);
    }

    /** Android 上由 looper 循环阻塞；这里线程本身什么都不做（调度由 Handler 承担） */
    @Override
    public void run() {
        synchronized (this) {
            looper = Looper.myLooper();
            notifyAll();
        }
    }

    public Looper getLooper() {
        synchronized (this) {
            if (looper == null) looper = Looper.getMainLooper();
            return looper;
        }
    }

    public int getThreadId() {
        return (int) getId();
    }

    public boolean quit() {
        return true;
    }

    public boolean quitSafely() {
        return true;
    }

    public String getThreadName() {
        return name;
    }

    @Override
    public String toString() {
        return "HandlerThread[" + name + "]";
    }
}