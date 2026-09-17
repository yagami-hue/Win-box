package android.view;

import android.os.Parcel;
import android.os.Parcelable;

/**
 * AccessibilityEvent stub —— 无障碍事件。
 * 桌面版无无障碍服务：只作为类型存在。
 */
public class AccessibilityEvent implements Parcelable {

    public static final int TYPE_VIEW_CLICKED = 0x00000001;
    public static final int TYPE_VIEW_LONG_CLICKED = 0x00000002;
    public static final int TYPE_VIEW_SELECTED = 0x00000004;
    public static final int TYPE_VIEW_FOCUSED = 0x00000008;
    public static final int TYPE_VIEW_SCROLLED = 0x00001000;
    public static final int TYPE_VIEW_TEXT_CHANGED = 0x00000010;
    public static final int TYPE_WINDOW_STATE_CHANGED = 0x00000020;
    public static final int TYPE_WINDOW_CONTENT_CHANGED = 0x00000800;
    public static final int TYPE_ANNOUNCEMENT = 0x00004000;

    private int eventType;

    public AccessibilityEvent() {
    }

    public AccessibilityEvent(int eventType) {
        this.eventType = eventType;
    }

    private AccessibilityEvent(Parcel in) {
        this.eventType = in.readInt();
    }

    public static AccessibilityEvent obtain() {
        return new AccessibilityEvent();
    }

    public static AccessibilityEvent obtain(int eventType) {
        return new AccessibilityEvent(eventType);
    }

    public void recycle() {
    }

    public int getEventType() {
        return eventType;
    }

    public void setEventType(int eventType) {
        this.eventType = eventType;
    }

    public void setPackageName(CharSequence packageName) {
    }

    public CharSequence getPackageName() {
        return null;
    }

    public void setClassName(CharSequence className) {
    }

    public CharSequence getClassName() {
        return null;
    }

    public void setText(java.util.List<CharSequence> text) {
    }

    public java.util.List<CharSequence> getText() {
        return new java.util.ArrayList<CharSequence>();
    }

    public void setContentDescription(CharSequence contentDescription) {
    }

    public CharSequence getContentDescription() {
        return null;
    }

    @Override
    public int describeContents() {
        return 0;
    }

    @Override
    public void writeToParcel(Parcel dest, int flags) {
        dest.writeInt(eventType);
    }

    public static final Creator<AccessibilityEvent> CREATOR = new Creator<AccessibilityEvent>() {
        @Override
        public AccessibilityEvent createFromParcel(Parcel in) {
            return new AccessibilityEvent(in);
        }

        @Override
        public AccessibilityEvent[] newArray(int size) {
            return new AccessibilityEvent[size];
        }
    };
}
