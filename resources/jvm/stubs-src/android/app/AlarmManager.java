package android.app;

/**
 * AlarmManager stub —— 系统闹钟/定时任务。
 *
 * 桌面版无系统级定时：所有 set* 方法只记录调用不抛异常（避免蜘蛛因为没有
 * 定时能力而整体失败），真正的定时逻辑由引擎侧 JS/TS 调度承担。
 */
public class AlarmManager {

    public static final int RTC_WAKEUP = 0;
    public static final int RTC = 1;
    public static final int ELAPSED_REALTIME_WAKEUP = 2;
    public static final int ELAPSED_REALTIME = 3;
    public static final long INTERVAL_FIFTEEN_MINUTES = 900000L;
    public static final long INTERVAL_HALF_HOUR = 1800000L;
    public static final long INTERVAL_HOUR = 3600000L;
    public static final long INTERVAL_HALF_DAY = 43200000L;
    public static final long INTERVAL_DAY = 86400000L;

    public AlarmManager() {
    }

    public void set(int type, long triggerAtMillis, PendingIntent operation) {
    }

    public void set(int type, long triggerAtMillis, String tag, PendingIntent operation) {
    }

    public void setRepeating(int type, long triggerAtMillis, long intervalMillis, PendingIntent operation) {
    }

    public void setInexactRepeating(int type, long triggerAtMillis, long intervalMillis, PendingIntent operation) {
    }

    public void setExact(int type, long triggerAtMillis, PendingIntent operation) {
    }

    public void setExactAndAllowWhileIdle(int type, long triggerAtMillis, PendingIntent operation) {
    }

    public void setAndAllowWhileIdle(int type, long triggerAtMillis, PendingIntent operation) {
    }

    public void setWindow(int type, long windowStartMillis, long windowLengthMillis, PendingIntent operation) {
    }

    public void cancel(PendingIntent operation) {
    }

    public void cancel(OnAlarmListener listener) {
    }

    public void set(String tag, long triggerAtMillis, OnAlarmListener listener, android.os.Handler targetHandler) {
    }

    public interface OnAlarmListener {
        void onAlarm();
    }
}
