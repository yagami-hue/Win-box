package android.app;

/**
 * ActivityManager stub —— 系统内存/进程信息。
 *
 * 真实调用面（扫描 Token.jar 确认）：`isLowRamDevice()Z`
 * 返回 false = "不是低内存设备"，让蜘蛛走常规内存策略（不主动降级缓存），
 * 这是桌面版最合理的语义。
 */
public class ActivityManager {

    public ActivityManager() {
    }

    public boolean isLowRamDevice() {
        return false;
    }

    public int getMemoryClass() {
        return 256;
    }

    public int getLargeMemoryClass() {
        return 512;
    }

    public boolean isUserAMonkey() {
        return false;
    }

    public static class MemoryInfo {
        public long totalMem = Runtime.getRuntime().maxMemory();
        public long availMem = Runtime.getRuntime().freeMemory();
        public long threshold = 0L;
        public boolean lowMemory = false;

        public void read() {
        }
    }
}
