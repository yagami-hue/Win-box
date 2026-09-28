package android.net;

/**
 * NetworkInfo stub —— 桌面版按「已连接（Wi-Fi）」上报：多数蜘蛛只拿它做
 * `isAvailable()/isConnected()` 的门禁，报「没网」会让它们直接返回空结果。
 */
public class NetworkInfo {

    public static final int TYPE_WIFI = 1;
    public static final int TYPE_MOBILE = 0;

    public NetworkInfo() {
    }

    public boolean isAvailable() {
        return true;
    }

    public boolean isConnected() {
        return true;
    }

    public boolean isConnectedOrConnecting() {
        return true;
    }

    public boolean isRoaming() {
        return false;
    }

    public int getType() {
        return TYPE_WIFI;
    }

    public String getTypeName() {
        return "WIFI";
    }

    public String getSubtypeName() {
        return "";
    }

    public int getSubtype() {
        return 0;
    }

    public String getReason() {
        return "";
    }

    /** Android 的 DetailedState 名称；此处用等价语义的常量字符串 */
    public String getState() {
        return "CONNECTED";
    }

    public String getDetailedState() {
        return "CONNECTED";
    }

    @Override
    public String toString() {
        return "NetworkInfo{WIFI, CONNECTED}";
    }
}