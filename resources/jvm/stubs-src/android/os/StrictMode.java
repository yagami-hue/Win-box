package android.os;

/**
 * StrictMode stub —— 严格模式（开发期检测主线程 IO / 网络 / 资源泄漏）。
 *
 * <p>真实调用面（扫描确认，Notice / XYQHiker 系蜘蛛）：
 * {@code StrictMode.ThreadPolicy.Builder}、{@code .detectAll()}、{@code .penaltyLog()}、
 * {@code .build()}、{@code StrictMode.setThreadPolicy(...)}。
 *
 * <p>★ Builder 的 setter 必须**返回 this**（链式调用是固定写法），
 * 返回 void 会 VerifyError。整个体系在桌面端是 no-op —— 桌面版没有
 * "主线程"概念，开启严格模式反而会误报大量 IO 异常。
 */
public final class StrictMode {

    private StrictMode() {
    }

    public static void setThreadPolicy(ThreadPolicy policy) {
    }

    public static ThreadPolicy getThreadPolicy() {
        return new ThreadPolicy.Builder().build();
    }

    public static ThreadPolicy allowThreadDiskReads() {
        return new ThreadPolicy.Builder().build();
    }

    public static ThreadPolicy allowThreadDiskWrites() {
        return new ThreadPolicy.Builder().build();
    }

    public static void setVmPolicy(VmPolicy policy) {
    }

    public static VmPolicy getVmPolicy() {
        return new VmPolicy.Builder().build();
    }

    /** 线程级策略。 */
    public static final class ThreadPolicy {

        private ThreadPolicy() {
        }

        /** 链式 Builder —— 所有 setter 返回 this。 */
        public static final class Builder {

            public Builder() {
            }

            public Builder(ThreadPolicy policy) {
            }

            public Builder detectAll() {
                return this;
            }

            public Builder detectDiskReads() {
                return this;
            }

            public Builder detectDiskWrites() {
                return this;
            }

            public Builder detectNetwork() {
                return this;
            }

            public Builder detectCustomSlowCalls() {
                return this;
            }

            public Builder permitAll() {
                return this;
            }

            public Builder permitDiskReads() {
                return this;
            }

            public Builder permitDiskWrites() {
                return this;
            }

            public Builder permitNetwork() {
                return this;
            }

            public Builder penaltyLog() {
                return this;
            }

            public Builder penaltyDialog() {
                return this;
            }

            public Builder penaltyDeath() {
                return this;
            }

            public Builder penaltyDropBox() {
                return this;
            }

            public Builder penaltyListener(java.util.concurrent.Executor executor, ViolationListener listener) {
                return this;
            }

            public ThreadPolicy build() {
                return new ThreadPolicy();
            }
        }
    }

    /** 虚拟机级策略。 */
    public static final class VmPolicy {

        private VmPolicy() {
        }

        public static final class Builder {

            public Builder() {
            }

            public Builder(VmPolicy policy) {
            }

            public Builder detectAll() {
                return this;
            }

            public Builder detectActivityLeaks() {
                return this;
            }

            public Builder detectLeakedSqlLiteObjects() {
                return this;
            }

            public Builder detectLeakedClosableObjects() {
                return this;
            }

            public Builder setClassInstanceLimit(Class<?> klass, int instanceLimit) {
                return this;
            }

            public Builder penaltyLog() {
                return this;
            }

            public Builder penaltyDeath() {
                return this;
            }

            public Builder penaltyDropBox() {
                return this;
            }

            public VmPolicy build() {
                return new VmPolicy();
            }
        }
    }

    /** 违规回调（桌面端不会被调用，仅为签名可达）。 */
    public interface ViolationListener {
        void onViolation(String message);
    }

    /** 违规信息载体。 */
    public static class ViolationInfo {
        public ViolationInfo() {
        }

        public String getMessage() {
            return "";
        }
    }
}
