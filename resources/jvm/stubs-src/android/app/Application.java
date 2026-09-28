package android.app;

import android.content.Context;

/**
 * Application stub（★ 2026-09-26 补源码版本：此前只有历史编译产物、无源码）。
 *
 * ★ 为什么要补：FishGuard / 摸鱼系壳 jar 的 `Init.init(Context)` 第一步就调
 *   `registerActivityLifecycleCallbacks(...)`，而 `ActivityLifecycleCallbacks` 是
 *   Application 的**嵌套接口** —— 缺它 → `ClassNotFoundException:
 *   android.app.Application$ActivityLifecycleCallbacks` → **Init 整体初始化失败**
 *   （真机实测：详情全空、部分源首页空；缺类还会连带 `Class.forName` 失败的 no-失败链）。
 *
 * 桌面端没有 Activity 生命周期与组件回调，故注册方法为 no-op（回调永不被触发），
 * 接口本身按 AOSP 签名补齐，保证实现类/调用方都能正常链接。
 */
public class Application extends Context {

    public Application() {
        super();
    }

    /** 与 Android 同名的嵌套接口（缺它即触发上面的 ClassNotFoundException） */
    public interface ActivityLifecycleCallbacks {
        void onActivityCreated(Activity activity, android.os.Bundle savedInstanceState);

        void onActivityStarted(Activity activity);

        void onActivityResumed(Activity activity);

        void onActivityPaused(Activity activity);

        void onActivityStopped(Activity activity);

        void onActivitySaveInstanceState(Activity activity, android.os.Bundle outState);

        void onActivityDestroyed(Activity activity);
    }

    /** 组件回调接口（桌面端无组件生命周期；只在 jar 确实引用时才需要，当前壳未用到，故不补） */

    public void registerActivityLifecycleCallbacks(ActivityLifecycleCallbacks callback) {
        // no-op：桌面端不产生 Activity 生命周期事件
    }

    public void unregisterActivityLifecycleCallbacks(ActivityLifecycleCallbacks callback) {
        // no-op
    }
}