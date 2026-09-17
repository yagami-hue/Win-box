package android.view;

/**
 * KeyEvent stub —— 按键事件。
 * 桌面版无实体按键：只作为类型存在，按键码恒 0 且 isDown=false。
 */
public class KeyEvent {

    public static final int ACTION_DOWN = 0;
    public static final int ACTION_UP = 1;
    public static final int ACTION_MULTIPLE = 2;

    public static final int KEYCODE_UNKNOWN = 0;
    public static final int KEYCODE_DPAD_UP = 19;
    public static final int KEYCODE_DPAD_DOWN = 20;
    public static final int KEYCODE_DPAD_LEFT = 21;
    public static final int KEYCODE_DPAD_RIGHT = 22;
    public static final int KEYCODE_DPAD_CENTER = 23;
    public static final int KEYCODE_BACK = 4;
    public static final int KEYCODE_HOME = 3;
    public static final int KEYCODE_MENU = 82;
    public static final int KEYCODE_ENTER = 66;
    public static final int KEYCODE_SPACE = 62;
    public static final int KEYCODE_DEL = 67;

    private final int action;
    private final int keyCode;

    public KeyEvent(int action, int code) {
        this.action = action;
        this.keyCode = code;
    }

    public KeyEvent(long downTime, long eventTime, int action, int code, int repeat) {
        this.action = action;
        this.keyCode = code;
    }

    public int getAction() {
        return action;
    }

    public int getKeyCode() {
        return keyCode;
    }

    public int getRepeatCount() {
        return 0;
    }

    public int getScanCode() {
        return 0;
    }

    public int getMetaState() {
        return 0;
    }

    public boolean isDown() {
        return action == ACTION_DOWN;
    }

    public static KeyEvent obtain(long downTime, long eventTime, int action, int code,
                                  int repeat, int metaState, int deviceId, int scancode,
                                  int flags, int source) {
        return new KeyEvent(action, code);
    }
}
