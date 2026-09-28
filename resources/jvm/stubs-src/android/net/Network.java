package android.net;

/** Network stub（API 21+ 的网络句柄）—— 桌面版只作类型占位：没有真实网络对象（见 ConnectivityManager）。 */
public class Network {

    private final int netId;

    public Network() {
        this(0);
    }

    public Network(int netId) {
        this.netId = netId;
    }

    public int getNetworkHandle() {
        return netId;
    }

    @Override
    public boolean equals(Object o) {
        return o instanceof Network && ((Network) o).netId == netId;
    }

    @Override
    public int hashCode() {
        return netId;
    }

    @Override
    public String toString() {
        return "Network{" + netId + "}";
    }
}