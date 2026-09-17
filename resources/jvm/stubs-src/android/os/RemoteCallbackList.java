package android.os;

import java.util.ArrayList;
import java.util.List;

/**
 * RemoteCallbackList stub —— Binder 回调注册表。
 *
 * 桌面版无跨进程回调：beginBroadcast() 返回 0（"没有注册者"），
 * 调用方随即 finishBroadcast()，天然走「无回调」路径而不会 NPE。
 */
public class RemoteCallbackList<E extends IInterface> {

    private final List<E> callbacks = new ArrayList<E>();

    public RemoteCallbackList() {
    }

    public boolean register(E callback) {
        return register(callback, null);
    }

    public boolean register(E callback, Object cookie) {
        if (callback == null) {
            return false;
        }
        synchronized (callbacks) {
            return callbacks.add(callback);
        }
    }

    public boolean unregister(E callback) {
        synchronized (callbacks) {
            return callbacks.remove(callback);
        }
    }

    public void kill() {
        synchronized (callbacks) {
            callbacks.clear();
        }
    }

    public void onCallbackDied(E callback) {
    }

    public void onCallbackDied(E callback, Object cookie) {
    }

    /** ★ 关键：返回 0 表示"没有注册的回调"，调用方会跳过广播循环 */
    public int beginBroadcast() {
        return 0;
    }

    public E getBroadcastItem(int index) {
        return null;
    }

    public Object getBroadcastCookie(int index) {
        return null;
    }

    public void finishBroadcast() {
    }

    public int getRegisteredCallbackCount() {
        synchronized (callbacks) {
            return callbacks.size();
        }
    }

    public E getRegisteredCallbackItem(int index) {
        return null;
    }
}
