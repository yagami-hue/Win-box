package android.os;

import java.util.concurrent.CancellationException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * AsyncTask stub —— ★ 2026-09-27 新补（真机取证：wex 玩偶的 `detailContent` 取详情时用它）。
 *
 * <p>缺这个类的表现：`java.lang.ClassNotFoundException: android.os.AsyncTask`
 * （在类链接期炸 → 整个详情页失败；补上后详情/播放链路才完整）。
 *
 * <p>真机语义只保留两处关键点，其余按桌面版最简实现：
 * <ul>
 *   <li>{@code execute(...)} 把 {@code doInBackground} 抛到后台线程跑；
 *       {@code get()} 阻塞到结果就绪 —— 蜘蛛惯用「new X().execute(...).get()」同步取值；</li>
 *   <li>{@code onPostExecute} 必须在 {@code get()} 返回**之前**跑完
 *       （蜘蛛惯用「onPostExecute 里赋值、get() 之后读字段」），因此它在同一线程里、
 *       latch 计数之前调用。</li>
 * </ul>
 * {@code doInBackground} 的异常由 {@code get()} 以 {@link ExecutionException} 抛出（不静默吞）。
 */
public abstract class AsyncTask<Params, Progress, Result> {

    private final CountDownLatch done = new CountDownLatch(1);
    private volatile Result result;
    private volatile Throwable error;
    private volatile boolean cancelled;

    public AsyncTask() {
    }

    protected void onPreExecute() {
    }

    protected abstract Result doInBackground(Params... params);

    protected void onPostExecute(Result result) {
    }

    protected void onProgressUpdate(Progress... values) {
    }

    protected void onCancelled() {
    }

    protected final void publishProgress(Progress... values) {
        onProgressUpdate(values);
    }

    /** 后台执行（守护线程）：先 onPreExecute，再 doInBackground，最后 onPostExecute + 放行 get() */
    public final AsyncTask<Params, Progress, Result> execute(Params... params) {
        Thread t = new Thread(() -> {
            try {
                try {
                    onPreExecute();
                } catch (Throwable ignored) {
                    // onPreExecute 失败不阻断任务
                }
                if (cancelled) {
                    onCancelled();
                    return;
                }
                result = doInBackground(params);
                if (!cancelled) onPostExecute(result);
            } catch (Throwable e) {
                error = e;
                onCancelled();
            } finally {
                done.countDown();
            }
        }, "winbox-async-task");
        t.setDaemon(true);
        t.start();
        return this;
    }

    public final Result get() throws InterruptedException, ExecutionException {
        done.await();
        if (error != null) throw new ExecutionException(error);
        if (cancelled) throw new CancellationException();
        return result;
    }

    public final Result get(long timeout, TimeUnit unit)
            throws InterruptedException, ExecutionException, TimeoutException {
        if (!done.await(timeout, unit)) throw new TimeoutException("AsyncTask.get 超时");
        if (error != null) throw new ExecutionException(error);
        if (cancelled) throw new CancellationException();
        return result;
    }

    public final boolean isCancelled() {
        return cancelled;
    }

    /** 取消只影响结果投递（后台线程不可强杀）；未开始的任务直接标记为已取消并放行 get()。 */
    public final boolean cancel(boolean mayInterruptIfRunning) {
        if (done.getCount() == 0) return false;
        cancelled = true;
        onCancelled();
        done.countDown();
        return true;
    }

    /** Android 11+ 的静态入口；蜘蛛偶用它跑一次性任务（不等待结果）。 */
    public static void execute(Runnable runnable) {
        if (runnable == null) return;
        Thread t = new Thread(runnable, "winbox-async-task-runnable");
        t.setDaemon(true);
        t.start();
    }

    public final AsyncTask<Params, Progress, Result> executeOnExecutor(Object executor, Params... params) {
        return execute(params);
    }
}