package android.app;

import java.util.HashMap;
import java.util.Map;

/**
 * ActivityThread stub —— 进程主线程对象（部分蜘蛛用它反查"当前前台 Activity"）。
 *
 * <p><b>为什么必须有这个类：</b>不少 TVBox 蜘蛛（如 {@code Market}）在 {@code init} 里
 * 调 {@code Init.checkPermission()}，后者用<b>反射</b>走真实安卓的私有 API：
 * <pre>
 *   Class&lt;?&gt; c   = Class.forName("android.app.ActivityThread");
 *   Method  m   = c.getMethod("currentActivityThread");
 *   Object  at  = m.invoke(null);              // 主线程对象
 *   Field   f   = c.getDeclaredField("mActivities");
 *   f.setAccessible(true);
 *   Map&lt;?, ?&gt; acts = (Map&lt;?, ?&gt;) f.get(at);     // 所有 ActivityRecord
 *   for (Object rec : acts.values()) {
 *       Field paused = rec.getClass().getDeclaredField("paused");
 *       paused.setAccessible(true);
 *       if (paused.getBoolean(rec)) continue;   // 只要没 paused 的
 *       Field act = rec.getClass().getDeclaredField("activity");
 *       act.setAccessible(true);
 *       return (Activity) act.get(rec);         // ← 前台 Activity
 *   }
 *   return null;                                // 没有就返回 null
 * </pre>
 *
 * <p>因为字符串被混淆成 XOR 编码，静态扫描代码里<b>看不到</b> "android.app.ActivityThread"
 * 这个字面量 —— 只有在运行时反射才暴露。缺失时表现为：
 * {@code ClassNotFoundException: android.app.ActivityThread}（在 {@code Init.getActivity} 里），
 * 而蜘蛛自己的 {@code try/catch} 未必拦住 → 表现为"蜘蛛不可用 / 返回空结果"。
 *
 * <p><b>本 stub 的语义选择：</b>桌面 TVBox 是<b>无 UI 常驻进程</b>，没有前台 Activity。
 * 因此：
 * <ul>
 *   <li>{@link #currentActivityThread()} 返回<b>非 null</b> 的进程对象 —— 反射链不炸；</li>
 *   <li>{@link #mActivities} 返回<b>非 null 的空 Map</b> —— {@code .values()} 不 NPE；</li>
 *   <li>空 Map ⇒ 循环一次都不进 ⇒ 蜘蛛拿到 {@code null} —— 与真实安卓"后台无前台页"完全一致。</li>
 * </ul>
 * 这样 {@code getActivity()} 走的是原版设计好的"返回 null"分支，而不是异常分支。
 *
 * <p>注意：{@code mActivities} <b>必须是实例字段（public，非 static）</b>，
 * 因为蜘蛛用 {@code getDeclaredField} 在<b>实例</b>上取它。
 */
public class ActivityThread {

    private static volatile ActivityThread sCurrent;

    /**
     * 所有 ActivityRecord。桌面无 UI ⇒ 恒为空，但不是 null。
     * 字段名与真实 AOSP 一致，蜘蛛靠 {@code getDeclaredField("mActivities")} 取。
     */
    public final Map<Object, Object> mActivities = new HashMap<Object, Object>();

    /** 进程 Application 实例（{@code currentApplication()} 用）。 */
    private Application mApplication;

    public ActivityThread() {
        // ★ 放入一个 mock ActivityClientRecord，使 InitOrigin.getActivity() 反射遍历
        //   mActivities 时能取到非 null Activity（fty 蛛 getan() 弹幕初始化会调
        //   Activity.getWindow().getDecorView()）。桌面无 UI，但需要一个非 null 占位
        //   Activity，让 getWindow 返回空 Window、视图遍历安全返回空结果。
        ActivityClientRecord rec = new ActivityClientRecord();
        rec.paused = false;
        rec.activity = new Activity();
        mActivities.put(rec, rec);
    }

    /**
     * 反射入口：等效 AOSP 的 {@code ActivityThread.currentActivityThread()}。
     * 惰性创建并缓存，保证多次调用拿到同一对象（蜘蛛可能会比较引用）。
     */
    public static ActivityThread currentActivityThread() {
        ActivityThread t = sCurrent;
        if (t == null) {
            synchronized (ActivityThread.class) {
                t = sCurrent;
                if (t == null) {
                    t = new ActivityThread();
                    sCurrent = t;
                }
            }
        }
        return t;
    }

    /** 等效 {@code ActivityThread.currentApplication()}。 */
    public static Application currentApplication() {
        return currentActivityThread().mApplication;
    }

    /**
     * 宿主侧注入点 —— 与真实 AOSP 不同，桌面版由 {@code Init.init(Context)} 主动喂进来。
     * 真实安卓里 {@code ActivityThread} 是 Application 的创建者，这里反过来。
     */
    public static void setCurrentApplication(Application app) {
        currentActivityThread().mApplication = app;
    }

    /** 实例方法版（部分代码写 {@code thread.getApplication()}）。 */
    public Application getApplication() {
        return mApplication;
    }

    /** 反射链里的 ActivityRecord（真实类名 {@code ActivityThread$ActivityClientRecord}）。 */
    public static class ActivityClientRecord {
        /** 是否已暂停。空 Map 下用不到，但契约要齐 —— 蜘蛛会 getDeclaredField。 */
        public boolean paused = true;
        /** 关联的 Activity。 */
        public Activity activity;
        public android.os.IBinder token;
        public android.content.Intent intent;
    }
}
