package android.net;

import java.util.List;

/**
 * ConnectivityManager stub —— ★ 2026-09-27 新补（wex 仓共用助手取 DNS 用：
 *   `getAllNetworks()` → `getNetworkCapabilities(n).hasCapability(12)` → `getLinkProperties(n).getDnsServers()`；
 *   缺类时整源 `ClassNotFoundException`）。
 *
 * <p>桌面版口径：**报告「无网络」**（`getAllNetworks()` 空数组、`getActiveNetworkInfo()` 已连接）——
 * 这样「遍历网络取 DNS」的助手会走它自己的默认分支（实测该分支就是给一个公共 DNS 常量），
 * 而不是拿到一份假的 DNS 列表去改请求。
 */
public class ConnectivityManager {

    public static final int TYPE_MOBILE = 0;
    public static final int TYPE_WIFI = 1;
    public static final int TYPE_ETHERNET = 9;
    public static final int TYPE_NONE = -1;

    public ConnectivityManager() {
    }

    public NetworkInfo getActiveNetworkInfo() {
        return new NetworkInfo();
    }

    public NetworkInfo[] getAllNetworkInfo() {
        return new NetworkInfo[]{new NetworkInfo()};
    }

    /** 空数组：调用方按「没有网络」处理（见类注释） */
    public Network[] getAllNetworks() {
        return new Network[0];
    }

    public Network getActiveNetwork() {
        return null;
    }

    public NetworkCapabilities getNetworkCapabilities(Network network) {
        return network == null ? null : new NetworkCapabilities();
    }

    public LinkProperties getLinkProperties(Network network) {
        return new LinkProperties();
    }

    public boolean isActiveNetworkMetered() {
        return false;
    }

    public int getActiveNetworkInfoType() {
        return TYPE_WIFI;
    }

    @SuppressWarnings("rawtypes")
    public List getDnsServers() {
        return new LinkProperties().getDnsServers();
    }
}