package android.content;

import android.os.Parcel;
import android.os.Parcelable;

/**
 * IntentSender stub —— PendingIntent 的弱引用句柄。
 *
 * 桌面版无 Binder，此对象只作为类型占位：sendIntent 不投递。
 */
public class IntentSender implements Parcelable {

    private IntentSender() {
    }

    public void sendIntent(Context context, int code, Intent intent,
                           OnFinished onFinished, android.os.Handler handler) {
    }

    public void sendIntent(Context context, int code, Intent intent,
                           OnFinished onFinished, android.os.Handler handler, String requiredPermission) {
    }

    public String getCreatorPackage() {
        return "org.tvbox.desktop";
    }

    public boolean equals(Object other) {
        return this == other;
    }

    public int hashCode() {
        return System.identityHashCode(this);
    }

    @Override
    public int describeContents() {
        return 0;
    }

    @Override
    public void writeToParcel(Parcel dest, int flags) {
    }

    public static final Creator<IntentSender> CREATOR = new Creator<IntentSender>() {
        @Override
        public IntentSender createFromParcel(Parcel source) {
            return new IntentSender();
        }

        @Override
        public IntentSender[] newArray(int size) {
            return new IntentSender[size];
        }
    };

    public interface OnFinished {
        void onSendFinished(IntentSender sender, Intent intent, int resultCode,
                            String resultData, android.os.Bundle resultExtras);
    }
}
