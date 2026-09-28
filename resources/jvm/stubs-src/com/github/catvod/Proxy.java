package com.github.catvod;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.Charset;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * com.github.catvod.Proxy —— **宿主侧**本地代理（安卓 TVBox 里由 App 提供，桌面版由本类提供）。
 *
 * ★ 为什么需要它（2026-09-26 契约取证，勿删）：
 *   jar 里的 `com.github.catvod.spider.Proxy.init()` 会
 *   `Class.forName("com.github.catvod.Proxy")` → `getPort()I` + `getUrl(Z)Ljava/lang/String;`；
 *   蜘蛛用 `com.github.catvod.spider.ProxyOrigin.buildUrl(url, headers)` 把「真实 url + 请求头」
 *   存进**本 JVM 的静态表** `ProxyOrigin.a/b`，再吐 `<getUrl()>?do=proxy&key=<key>`。
 *   因此 key 只有**本 JVM** 能解 —— 本地代理必须跑在蜘蛛 JVM 里（TS 侧 9978 服务拿不到那张表），
 *   本类就是那个「在 JVM 内的小 HTTP 服务」：收到请求 → 反射调用 jar 内的
 *   `spider.Proxy.proxy(Map)`（与安卓同一条路径）→ 原样回写状态码/Content-Type/流。
 *
 * 端口与对外入口：
 *   · 内部端口 = `-Dtvbox.proxy.port`（宿主按源分配，便于宿主侧转发/钉住进程），未设则取临时端口；
 *   · 对外 base = `-Dtvbox.proxy.entry`（宿主给的入口，形如 `http://127.0.0.1:9978/proxy/<port>`，
 *     由 TS 侧服务再转发回本进程）；未设则自报 `http://127.0.0.1:<port>/proxy`。
 *
 * 说明：JRE 是 jlink 裁剪版，**没有 jdk.httpserver**，故这里用 ServerSocket 实现极简 HTTP/1.0
 * （Connection: close，逐请求一线程；只做 GET/HEAD）。
 *
 * ★★ 硬前提：蜘蛛 JVM 必须以 **UTF-8 作为默认字符集**（`-Dfile.encoding=UTF-8`，`JarSpiderBridge.jvmPrefix`
 *   已固定带上并被 `tests/jvmSpawnArgs.spec.ts` 断言守住）。原因（2026-09-26 实证）：壳用**默认字符集**
 *   解自己加密表里的字符串常量 —— 默认是 GBK 时，类名 `com.github.catvod.spider.merge.A.半杯清茶品人生`
 *   会被解成乱码（`鍓戞皵…\ufffd`）→ `Class.forName` 返回 null → 壳内反射调用 NPE
 *   （现象：`Proxy error: Cannot invoke "java.lang.reflect.Method.invoke" because "<parameter1>" is null`，
 *   抛出链 `merge.A.l1.b → merge.u.J.call → ProxyOrigin.a(Callable)`）。
 *   加了 `-Dfile.encoding=UTF-8` 后同一条链路实测 **200 + 真实网页正文**。
 */
public final class Proxy {

    private static final Charset UTF8 = Charset.forName("UTF-8");

    private static volatile boolean started;
    private static volatile int port = -1;
    /** 蜘蛛侧 Proxy 类（解析 key→url/headers 的处理器）与其所在类加载器（首次调用者的） */
    private static volatile ClassLoader callerLoader;
    private static volatile Method handler;

    private Proxy() {
    }

    /** 宿主（jar 里的 spider.Proxy.init）经反射调用：本地代理监听端口 */
    public static int getPort() {
        ensure();
        return port;
    }

    /** 宿主经反射调用：代理入口 base（蜘蛛会把 `?do=proxy&key=…` 接在它后面） */
    public static String getUrl(boolean local) {
        ensure();
        String entry = System.getProperty("tvbox.proxy.entry", "").trim();
        if (!entry.isEmpty()) return entry;
        return "http://127.0.0.1:" + port + "/proxy";
    }

    private static synchronized void ensure() {
        if (started) return;
        started = true;
        captureCallerLoader();
        int want = 0;
        try {
            want = Integer.parseInt(System.getProperty("tvbox.proxy.port", "0").trim());
        } catch (Throwable ignore) {
        }
        ServerSocket ss = null;
        try {
            ss = bind(want);
        } catch (Throwable t) {
            try {
                ss = bind(0);
            } catch (Throwable t2) {
                System.err.println("[host-proxy] 本地代理启动失败: " + t2);
                started = false;
                return;
            }
        }
        port = ss.getLocalPort();
        final ServerSocket server = ss;
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                acceptLoop(server);
            }
        }, "tvbox-host-proxy");
        t.setDaemon(true);
        t.start();
    }

    private static ServerSocket bind(int p) throws Exception {
        ServerSocket ss = new ServerSocket();
        ss.setReuseAddress(true);
        ss.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), p), 32);
        return ss;
    }

    /** 首次调用来自蜘蛛线程 → 栈上第一个「不是本类加载器」的类就是蜘蛛 jar 的加载器 */
    private static void captureCallerLoader() {
        try {
            final ClassLoader mine = Proxy.class.getClassLoader();
            StackWalker.getInstance(StackWalker.Option.RETAIN_CLASS_REFERENCE).forEach(f -> {
                if (callerLoader != null) return;
                ClassLoader cl = f.getDeclaringClass().getClassLoader();
                if (cl != null && cl != mine) callerLoader = cl;
            });
        } catch (Throwable ignore) {
        }
    }

    private static void acceptLoop(ServerSocket server) {
        while (true) {
            Socket s = null;
            try {
                s = server.accept();
            } catch (Throwable t) {
                return; // socket 关了 / 进程退出
            }
            final Socket sock = s;
            Thread t = new Thread(new Runnable() {
                @Override
                public void run() {
                    handle(sock);
                }
            }, "tvbox-host-proxy-req");
            t.setDaemon(true);
            t.start();
        }
    }

    private static void handle(Socket sock) {
        try (Socket s = sock) {
            // ★ 请求线程带上**蜘蛛 jar 的类加载器**（安卓同款：宿主与 jar 同加载器）。
            //   本服务的线程是新起的，否则会继承应用加载器；壳内若有用 TCCL 取资源/加载类的代码
            //   就会落空（Android 侧不存在这个问题）。★ 注意：`merge.A.l1.b` 的 NPE **不是**这条引起的
            //   —— 那次真因是「壳用**默认字符集**解自己的字符串常量」，见下方类注释的 UTF-8 要求。
            ClassLoader jarLoader = callerLoader;
            if (jarLoader != null) {
                try {
                    Thread.currentThread().setContextClassLoader(jarLoader);
                } catch (Throwable ignore) {
                }
            }
            s.setSoTimeout(15000);
            InputStream in = s.getInputStream();
            OutputStream out = s.getOutputStream();
            // 请求行 + 头（这一层只需要请求行；头读到空行为止）
            String requestLine = readLine(in);
            if (requestLine == null || requestLine.isEmpty()) return;
            String headers = "";
            for (int i = 0; i < 64; i++) {
                String line = readLine(in);
                if (line == null || line.isEmpty()) break;
                headers += line + "\n";
            }
            String[] parts = requestLine.split(" ");
            if (parts.length < 2) {
                writeSimple(out, 400, "text/plain; charset=utf-8", "Bad request".getBytes(UTF8), false);
                return;
            }
            String method = parts[0];
            String target = parts[1];
            int q = target.indexOf('?');
            String path = q >= 0 ? target.substring(0, q) : target;
            String query = q >= 0 ? target.substring(q + 1) : "";
            boolean head = "HEAD".equalsIgnoreCase(method);

            if (!"/proxy".equals(path)) {
                writeSimple(out, 404, "text/plain; charset=utf-8", ("Not found: " + path).getBytes(UTF8), head);
                return;
            }
            Map<String, String> params = parseQuery(query);
            if (params.isEmpty()) {
                // 与安卓侧同款文案（jar 里那串 "Missing parameters"）
                writeSimple(out, 400, "text/plain; charset=utf-8", "Missing parameters".getBytes(UTF8), head);
                return;
            }
            Object[] r = dispatch(params);
            int status = r != null && r.length > 0 && r[0] instanceof Integer ? ((Integer) r[0]) : 500;
            String ctype = r != null && r.length > 1 && r[1] instanceof String ? (String) r[1] : "application/octet-stream";
            InputStream body = r != null && r.length > 2 && r[2] instanceof InputStream ? (InputStream) r[2] : null;
            if (body == null) {
                writeSimple(out, status, ctype, new byte[0], head);
                return;
            }
            // 流式转发：不缓冲整段（媒体可能很大）→ 用 Connection: close 分帧
            writeHead(out, status, ctype, -1, true);
            if (!head) copy(body, out);
            out.flush();
        } catch (Throwable t) {
            // 客户端提前断开是常态（播放器 seek），只记一行
            System.err.println("[host-proxy] 请求处理失败: " + t);
        }
    }

    /** 反射调用 jar 内的处理器：`com.github.catvod.spider.Proxy.proxy(Map) → Object[]{status, contentType, InputStream}` */
    private static Object[] dispatch(Map<String, String> params) {
        try {
            Method m = handler;
            if (m == null) {
                ClassLoader cl = callerLoader;
                if (cl == null) cl = Thread.currentThread().getContextClassLoader();
                Class<?> c = Class.forName("com.github.catvod.spider.Proxy", true, cl);
                m = c.getMethod("proxy", Map.class);
                handler = m;
            }
            Object r = m.invoke(null, params);
            return r instanceof Object[] ? (Object[]) r : null;
        } catch (Throwable t) {
            Throwable root = t;
            while (root.getCause() != null && root.getCause() != root) root = root.getCause();
            System.err.println("[host-proxy] 处理器调用失败: " + root);
            return new Object[]{500, "text/plain; charset=utf-8", new java.io.ByteArrayInputStream(
                    ("proxy handler failed: " + root).getBytes(UTF8))};
        }
    }

    private static Map<String, String> parseQuery(String query) {
        Map<String, String> map = new LinkedHashMap<>();
        if (query == null || query.isEmpty()) return map;
        for (String pair : query.split("&")) {
            if (pair.isEmpty()) continue;
            int eq = pair.indexOf('=');
            String k = eq >= 0 ? pair.substring(0, eq) : pair;
            String v = eq >= 0 ? pair.substring(eq + 1) : "";
            map.put(urlDecode(k), urlDecode(v));
        }
        return map;
    }

    private static String urlDecode(String s) {
        try {
            return java.net.URLDecoder.decode(s, "UTF-8");
        } catch (Throwable t) {
            return s;
        }
    }

    private static String readLine(InputStream in) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream(128);
        int c;
        while ((c = in.read()) >= 0) {
            if (c == '\n') break;
            if (c != '\r') bos.write(c);
            if (bos.size() > 8192) break;
        }
        if (c < 0 && bos.size() == 0) return null;
        return bos.toString("UTF-8");
    }

    private static void writeSimple(OutputStream out, int status, String ctype, byte[] body, boolean head) throws Exception {
        writeHead(out, status, ctype, body.length, true);
        if (!head && body.length > 0) out.write(body);
        out.flush();
    }

    private static void writeHead(OutputStream out, int status, String ctype, int length, boolean close) throws Exception {
        StringBuilder sb = new StringBuilder();
        sb.append("HTTP/1.1 ").append(status).append(' ').append(statusText(status)).append("\r\n");
        sb.append("Content-Type: ").append(ctype == null ? "application/octet-stream" : ctype).append("\r\n");
        if (length >= 0) sb.append("Content-Length: ").append(length).append("\r\n");
        sb.append("Access-Control-Allow-Origin: *\r\n");
        sb.append("Connection: ").append(close ? "close" : "keep-alive").append("\r\n\r\n");
        out.write(sb.toString().getBytes(UTF8));
    }

    private static String statusText(int code) {
        switch (code) {
            case 200: return "OK";
            case 206: return "Partial Content";
            case 301: return "Moved Permanently";
            case 302: return "Found";
            case 400: return "Bad Request";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 500: return "Internal Server Error";
            default: return "OK";
        }
    }

    private static void copy(InputStream in, OutputStream out) throws Exception {
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
            out.flush();
        }
    }
}