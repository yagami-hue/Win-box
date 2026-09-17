package android.content.pm;

/**
 * Signature stub。
 *
 * ★ 关键：绝不能返回空数组！
 *
 * 大量 TVBox 蜘蛛（如 fty.jar 内的 Auete/Bttwoo/Libvio/LiteApple）会用
 * `context.getPackageManager().getPackageInfo(pkg, 64).signatures[0].toByteArray()`
 * 做**签名校验**，并把校验得到的摘要当作**解密密钥**去解自己的字符串常量
 * （URL / 接口地址 / 请求头都在里面）。若 signatures 为空 → 取 [0] 抛
 * ArrayIndexOutOfBoundsException → 拿不到密钥 → 解出的"URL"是乱码 →
 * HTTP 拿到乱码 → `JSONException: A JSONObject text must begin with '{'`
 * → 主页空白（也就是用户看到的「蜘蛛返回空结果」）。
 *
 * 桌面移植版无法复刻原始 APK 的签名私钥，因此这里返回一段**非空占位字节**。
 * 只要能通过长度校验、不抛数组越界，蜘蛛自身的容错分支（try/catch + 默认值）
 * 就能继续走完，拿到默认接口地址。
 */
public class Signature {
    /**
     * 占位签名字节。刻意用一段"看起来像 DER 结构"的非空字节，
     * 避免某些蜘蛛额外做 length 检查时提前失败。
     */
    private static final byte[] PLACEHOLDER = new byte[]{
            0x30, (byte) 0x82, 0x03, 0x10, 0x06, 0x09, 0x2A, (byte) 0x86,
            0x48, (byte) 0x86, (byte) 0xF7, 0x0D, 0x01, 0x07, 0x02, (byte) 0xA0
    };

    private final byte[] mSignature;

    public Signature(byte[] signature) {
        this.mSignature = (signature == null || signature.length == 0)
                ? PLACEHOLDER.clone()
                : signature;
    }

    public byte[] toByteArray() { return mSignature; }

    @Override public int hashCode() { return java.util.Arrays.hashCode(mSignature); }

    @Override public boolean equals(Object obj) {
        if (!(obj instanceof Signature)) return false;
        return java.util.Arrays.equals(mSignature, ((Signature) obj).mSignature);
    }

    @Override public String toString() { return "Signature[bytes=" + mSignature.length + "]"; }
}
