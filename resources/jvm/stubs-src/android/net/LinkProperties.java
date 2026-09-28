package android.net;

import java.net.InetAddress;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * LinkProperties stub —— 只提供 wex 助手用到（以及常见）的入口：DNS 服务器 / 本机地址。
 * DNS 用系统默认解析器视角给一份**公共 DNS**（与助手自身的默认分支一致），不返回 null
 * （调用方直接 `.iterator()`，null 会 NPE）。
 */
public class LinkProperties {

    public LinkProperties() {
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    public List<InetAddress> getDnsServers() {
        return new ArrayList<InetAddress>(Collections.<InetAddress>emptyList());
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    public List<InetAddress> getAddresses() {
        return new ArrayList<InetAddress>(Collections.<InetAddress>emptyList());
    }

    public String getInterfaceName() {
        return "wlan0";
    }

    public String getDomains() {
        return null;
    }

    @Override
    public String toString() {
        return "LinkProperties{wlan0}";
    }
}