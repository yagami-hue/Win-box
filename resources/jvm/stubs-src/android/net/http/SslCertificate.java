package android.net.http;

/**
 * SslCertificate stub —— 证书信息载体。
 *
 * <p>真实调用面：{@code getIssuedTo()} / {@code getIssuedBy()} / {@code getValidNotBefore()}
 * 等。桌面端不产生该对象，返回空/安全的默认值即可。
 */
public class SslCertificate {

    public SslCertificate(String issuedTo, String issuedBy, String validNotBefore, String validNotAfter) {
    }

    public static SslCertificate saveState(SslCertificate certificate) {
        return certificate;
    }

    public static SslCertificate restoreState(android.os.Bundle bundle) {
        return null;
    }

    public DName getIssuedTo() {
        return new DName("");
    }

    public DName getIssuedBy() {
        return new DName("");
    }

    public String getValidNotBefore() {
        return "";
    }

    public String getValidNotAfter() {
        return "";
    }

    public android.os.Bundle saveState() {
        return new android.os.Bundle();
    }

    @Override
    public String toString() {
        return "";
    }

    /** 证书主体/签发者名称。 */
    public static class DName {
        private final String mDName;

        public DName(String dName) {
            this.mDName = dName == null ? "" : dName;
        }

        public String getDName() {
            return mDName;
        }

        public String getCName() {
            return mDName;
        }

        public String getOName() {
            return "";
        }

        public String getUName() {
            return "";
        }

        @Override
        public String toString() {
            return mDName;
        }
    }
}
