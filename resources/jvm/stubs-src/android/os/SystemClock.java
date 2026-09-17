package android.os;

/** SystemClock stub：蜘蛛用 sleep 做节流。 */
public class SystemClock {
    public static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    public static long elapsedRealtime() { return System.nanoTime() / 1_000_000L; }
    public static long uptimeMillis() { return System.nanoTime() / 1_000_000L; }
    public static long currentThreadTimeMillis() { return System.nanoTime() / 1_000_000L; }
}
