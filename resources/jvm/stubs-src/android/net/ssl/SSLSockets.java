package android.net.ssl;

import javax.net.ssl.SSLSocket;

/**
 * SSLSockets stub —— SSL 会话优化开关。
 *
 * 真实调用面（扫描确认）：`setUseSessionTickets(SSLSocket;Z)V`
 * 这是纯静态工具方法：只是想开启 TLS 会话票证复用。
 * 桌面版 JVM 的 SSLSocket 本身已支持会话复用，这里做成幂等空实现
 * （保持签名一致即可，不做任何实际配置以避免抛 UnsupportedOperationException）。
 */
public final class SSLSockets {

    private SSLSockets() {
    }

    @SuppressWarnings("deprecation")
    public static boolean isCleartextTrafficPermitted(SSLSocket socket) {
        return true;
    }

    public static void setUseSessionTickets(SSLSocket socket, boolean useSessionTickets) {
        // 幂等空实现 —— 见类注释
    }

    public static void setHostname(SSLSocket socket, String hostname) {
        // 幂等空实现
    }
}
