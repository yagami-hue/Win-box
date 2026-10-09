package com.github.catvod.spider;

import android.content.Context;

/** 私有类不能放在 -cp 上：它必须经蜘蛛 JAR 的加载器可见。 */
public class LoaderProbe {
    private Context context;

    public void init(Context value, String ext) { context = value; }

    private static String value(ClassLoader loader) throws Exception {
        Class<?> helper = loader.loadClass("fixture.PrivateHelper");
        return (String) helper.getMethod("value").invoke(null);
    }

    public String homeContent(boolean filter) throws Exception {
        return value(context.getClassLoader());
    }

    public String searchContent(String key, boolean quick) throws Exception {
        return value(Thread.currentThread().getContextClassLoader());
    }

    public String liveContent(String key) throws Exception {
        final String[] result = new String[1];
        Thread child = new Thread(() -> {
            try { result[0] = value(Thread.currentThread().getContextClassLoader()); }
            catch (Exception error) { result[0] = error.toString(); }
        });
        child.start(); child.join();
        return result[0];
    }

    public String homeVideoContent() throws Exception {
        // 真实实现不在外壳 JAR，只在 shellShimClasses 的独立 JAR。
        com.github.catvod.spider.DexNative.getLoader(context);
        String first = value(context.getClassLoader());
        Context second = new Context();
        com.github.catvod.spider.DexNative.getLoader(second);
        return first + ":" + value(second.getClassLoader()) + ":" + value(Thread.currentThread().getContextClassLoader());
    }
}
