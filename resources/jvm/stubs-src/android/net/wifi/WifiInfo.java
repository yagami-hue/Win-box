package android.net.wifi;

/**
 * WifiInfo stub —— 与 {@link WifiManager} 配套（wex 指纹助手要 `getIpAddress()`）。
 * 其余取值给**稳定常量**（Android 6+ 无权限时真实设备也返回这些占位值）。
 */
public class WifiInfo {

    public static final int LINK_SPEED_UNKNOWN = -1;
    public static final int INVALID_NETWORK_ID = -1;
    public static final int INVALID_RSSI = -127;

    public WifiInfo() {
    }

    /** Android 口径：little-endian int；本机无可用 IPv4 时为 0 */
    public int getIpAddress() {
        return WifiManager.localIpv4();
    }

    /** 无权限时 Android 返回的占位 MAC（保持稳定，避免指纹每跑一次都变） */
    public String getMacAddress() {
        return "02:00:00:00:00:00";
    }

    public String getSSID() {
        return "<unknown ssid>";
    }

    public String getBSSID() {
        return "02:00:00:00:00:00";
    }

    public int getNetworkId() {
        return INVALID_NETWORK_ID;
    }

    public int getLinkSpeed() {
        return LINK_SPEED_UNKNOWN;
    }

    public int getRssi() {
        return INVALID_RSSI;
    }

    public int getFrequency() {
        return 0;
    }

    public boolean isHidden() {
        return false;
    }

    @Override
    public String toString() {
        return "WifiInfo{ssid=" + getSSID() + ", ip=" + getIpAddress() + "}";
    }
}