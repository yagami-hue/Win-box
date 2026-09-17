package android.app;

import android.os.Parcel;
import android.os.Parcelable;

/**
 * PendingIntent stub —— 延迟/跨进程 Intent 包装。
 *
 * 桌面版无组件体系，PendingIntent 无实际投递能力。但它是很多签名的参数类型，
 * 因此必须可加载、可 get*、可描述。所有 get* 只返回记录下来的参数。
 */
public class PendingIntent implements Parcelable {

    public static final int FLAG_ONE_SHOT = 0x40000000;
    public static final int FLAG_NO_CREATE = 0x20000000;
    public static final int FLAG_CANCEL_CURRENT = 0x10000000;
    public static final int FLAG_UPDATE_CURRENT = 0x08000000;
    public static final int FLAG_IMMUTABLE = 0x04000000;
    public static final int FLAG_MUTABLE = 0x02000000;

    private final String creatorPackage;

    private PendingIntent(String creatorPackage) {
        this.creatorPackage = creatorPackage == null ? "org.tvbox.desktop" : creatorPackage;
    }

    // ---------------- 静态工厂（★ 真实调用入口） ----------------

    public static PendingIntent getActivity(android.content.Context context, int requestCode,
                                            android.content.Intent intent, int flags) {
        return new PendingIntent(context == null ? null : context.getPackageName());
    }

    public static PendingIntent getActivity(android.content.Context context, int requestCode,
                                            android.content.Intent intent, int flags, android.os.Bundle options) {
        return new PendingIntent(context == null ? null : context.getPackageName());
    }

    public static PendingIntent getActivities(android.content.Context context, int requestCode,
                                              android.content.Intent[] intents, int flags) {
        return new PendingIntent(context == null ? null : context.getPackageName());
    }

    public static PendingIntent getBroadcast(android.content.Context context, int requestCode,
                                             android.content.Intent intent, int flags) {
        return new PendingIntent(context == null ? null : context.getPackageName());
    }

    public static PendingIntent getService(android.content.Context context, int requestCode,
                                           android.content.Intent intent, int flags) {
        return new PendingIntent(context == null ? null : context.getPackageName());
    }

    public static PendingIntent getForegroundService(android.content.Context context, int requestCode,
                                                     android.content.Intent intent, int flags) {
        return new PendingIntent(context == null ? null : context.getPackageName());
    }

    // ---------------- 实例方法 ----------------

    public void send() {
    }

    public void send(int code) {
    }

    public void send(int code, android.content.Intent intent) {
    }

    public void send(android.content.Context context, int code, android.content.Intent intent) {
    }

    public void send(android.content.Context context, int code, android.content.Intent intent,
                     OnFinished onFinished, android.os.Handler handler) {
    }

    public void cancel() {
    }

    public String getCreatorPackage() {
        return creatorPackage;
    }

    public int getCreatorUid() {
        return 0;
    }

    public String getCreatorUserHandle() {
        return null;
    }

    public boolean isImmutable() {
        return true;
    }

    public android.content.IntentSender getIntentSender() {
        return null;
    }

    // ---------------- Parcelable ----------------

    @Override
    public int describeContents() {
        return 0;
    }

    @Override
    public void writeToParcel(Parcel dest, int flags) {
    }

    public static final Creator<PendingIntent> CREATOR = new Creator<PendingIntent>() {
        @Override
        public PendingIntent createFromParcel(Parcel source) {
            return new PendingIntent(null);
        }

        @Override
        public PendingIntent[] newArray(int size) {
            return new PendingIntent[size];
        }
    };

    public interface OnFinished {
        void onSendFinished(PendingIntent pendingIntent, android.content.Intent intent,
                            int resultCode, String resultData, android.os.Bundle resultExtras);
    }
}
