package android.net;

/**
 * NetworkCapabilities stub —— 「能力位」全部按「有网」应答。
 * wex 助手会问 `hasCapability(12)`（= NET_CAPABILITY_INTERNET），答 false 会让它跳过整段逻辑。
 */
public class NetworkCapabilities {

    public static final int NET_CAPABILITY_INTERNET = 12;
    public static final int NET_CAPABILITY_NOT_RESTRICTED = 13;
    public static final int NET_CAPABILITY_TRUSTED = 14;
    public static final int NET_CAPABILITY_NOT_METERED = 11;
    public static final int NET_CAPABILITY_VALIDATED = 16;

    public NetworkCapabilities() {
    }

    public boolean hasCapability(int capability) {
        return true;
    }

    public boolean hasTransport(int transportType) {
        return transportType == ConnectivityManager.TYPE_WIFI;
    }

    public int[] getCapabilities() {
        return new int[]{NET_CAPABILITY_INTERNET, NET_CAPABILITY_NOT_RESTRICTED, NET_CAPABILITY_TRUSTED};
    }

    @Override
    public String toString() {
        return "NetworkCapabilities{INTERNET}";
    }
}