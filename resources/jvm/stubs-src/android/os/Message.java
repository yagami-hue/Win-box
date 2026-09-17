package android.os;

/**
 * Message stub —— Handler 消息载体。
 *
 * <p>真实调用面：WebViewClient#onFormResubmission / WebChromeClient#onCreateWindow
 * / WebView#requestFocusNodeHref 的形参类型。
 *
 * <p>★ 这是**数据承载类**，必须真实保存 {@code what}/{@code arg1}/{@code arg2}/
 * {@code obj}：内嵌库创建 Message 后由调用方读取这些字段做分发。
 * 空壳会让消息路由静默失效（不报错，但没有回调）。
 *
 * <p>★ {@code obtain()} 静态工厂返回非 null 实例，参考安卓原版的复用池语义
 * （这里简化为直接 new，桌面端消息量极小，不需要池）。
 */
public final class Message {

    /** 与安卓原版一致的默认值。 */
    public static final int UID_NONE = -1;

    public int what;
    public int arg1;
    public int arg2;
    public Object obj;
    public long when;
    public Bundle data;
    public Handler target;
    public Runnable callback;
    public int flags;
    public int sendingUid = UID_NONE;
    public int workSourceUid = UID_NONE;

    public Message() {
    }

    public static Message obtain() {
        return new Message();
    }

    public static Message obtain(Handler h) {
        Message m = new Message();
        m.target = h;
        return m;
    }

    public static Message obtain(Handler h, int what) {
        Message m = obtain(h);
        m.what = what;
        return m;
    }

    public static Message obtain(Handler h, int what, Object obj) {
        Message m = obtain(h, what);
        m.obj = obj;
        return m;
    }

    public static Message obtain(Handler h, int what, int arg1, int arg2) {
        Message m = obtain(h, what);
        m.arg1 = arg1;
        m.arg2 = arg2;
        return m;
    }

    public static Message obtain(Handler h, int what, int arg1, int arg2, Object obj) {
        Message m = obtain(h, what, arg1, arg2);
        m.obj = obj;
        return m;
    }

    public static Message obtain(Handler h, Runnable callback) {
        Message m = obtain(h);
        m.callback = callback;
        return m;
    }

    public static Message obtain(Message orig) {
        Message m = new Message();
        if (orig != null) {
            m.what = orig.what;
            m.arg1 = orig.arg1;
            m.arg2 = orig.arg2;
            m.obj = orig.obj;
            m.when = orig.when;
        }
        return m;
    }

    public void setTarget(Handler target) {
        this.target = target;
    }

    public Handler getTarget() {
        return target;
    }

    public Runnable getCallback() {
        return callback;
    }

    public Bundle getData() {
        if (data == null) data = new Bundle();
        return data;
    }

    public Bundle peekData() {
        return data;
    }

    public void setData(Bundle data) {
        this.data = data;
    }

    public void sendToTarget() {
        if (target != null) target.sendMessage(this);
    }

    public void recycle() {
        what = 0;
        arg1 = 0;
        arg2 = 0;
        obj = null;
        callback = null;
        target = null;
        data = null;
    }

    public void copyFrom(Message o) {
        if (o == null) return;
        this.what = o.what;
        this.arg1 = o.arg1;
        this.arg2 = o.arg2;
        this.obj = o.obj;
        this.when = o.when;
        this.data = o.data;
    }

    public boolean isAsynchronous() {
        return (flags & 1) != 0;
    }

    public void setAsynchronous(boolean async) {
        flags = async ? (flags | 1) : (flags & ~1);
    }

    @Override
    public String toString() {
        return "Message{what=" + what + ", arg1=" + arg1 + ", arg2=" + arg2 + "}";
    }
}
