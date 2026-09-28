package android.net.wifi;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;

/**
 * WifiManager stub —— ★ 2026-09-27 新补（真机取证：wex 仓多只源共用的 device 指纹助手
 *   `merge/.../oOoO0OoO0oOo0oOo.oOoOoOoOoOoOoO0o(Context)` 会
 *   `context.getSystemService(WIFI_SERVICE)` → `WifiManager.getConnectionInfo().getIpAddress()`；
 *   缺这个类时整源 `ClassNotFoundException: android.net.wifi.WifiManager`）。
 *
 * <p>取值口径：桌面版没有 Wi-Fi，但**不能返回 null/0**（指纹会退化成常量，部分源据此判「异常环境」）。
 * 因此本机有站点内 IPv4 时返回它（与 Android 的 little-endian int 口径一致），否则 0。
 */
public class WifiManager {

    public static final int WIFI_STATE_DISABLED = 1;
    public static final int WIFI_STATE_DISABLING = 0;
    public static final int WIFI_STATE_ENABLED = 3;
    public static final int WIFI_STATE_ENABLING = 2;
    public static final int WIFI_STATE_UNKNOWN = 4;

    private final WifiInfo info = new WifiInfo();

    public WifiManager() {
    }

    public WifiInfo getConnectionInfo() {
        return info;
    }

    public boolean isWifiEnabled() {
        return true;
    }

    public boolean setWifiEnabled(boolean enabled) {
        return true;
    }

    public int getWifiState() {
        return WIFI_STATE_ENABLED;
    }

    public boolean isScanAlwaysAvailable() {
        return false;
    }

    /** 空列表（原始类型返回，避免再引入 ScanResult 类；调用方按擦除后的 List 链接） */
    @SuppressWarnings("rawtypes")
    public List getScanResults() {
        return new ArrayList();
    }

    public boolean reconnect() {
        return true;
    }

    public boolean disconnect() {
        return true;
    }

    public boolean startScan() {
        return true;
    }

    /** 本机站点内 IPv4（Android 口径：little-endian int，便于调用方按 a.b.c.d 拼字符串） */
    static int localIpv4() {
        try {
            Enumeration<NetworkInterface> nis = NetworkInterface.getNetworkInterfaces();
            if (nis == null) return 0;
            for (NetworkInterface ni : Collections.list(nis)) {
                if (ni == null || ni.isLoopback() || !ni.isUp()) continue;
                for (InetAddress addr : Collections.list(ni.getInetAddresses())) {
                    if (addr instanceof Inet4Address && !addr.isLoopbackAddress()) {
                        byte[] b = addr.getAddress();
                        return (b[3] & 0xff) << 24 | (b[2] & 0xff) << 16 | (b[1] & 0xff) << 8 | (b[0] & 0xff);
                    }
                }
            }
        } catch (Throwable ignored) {
            // 取不到按 0 处理
        }
        return 0;
    }
}