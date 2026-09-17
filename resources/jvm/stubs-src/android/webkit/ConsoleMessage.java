package android.webkit;

/**
 * ConsoleMessage stub —— WebView 控制台日志条目。
 *
 * <p>真实调用面：{@code message()} / {@code messageLevel()} / {@code sourceId()} /
 * {@code lineNumber()}。内嵌 WebView 库的 {@code onConsoleMessage} 会读这些字段。
 * 桌面端不产生控制台消息（返回空/0 即可），但 getter 必须存在且不抛。
 */
public class ConsoleMessage {

    private final String mMessage;
    private final String mSourceId;
    private final int mLineNumber;
    private final MessageLevel mLevel;

    public enum MessageLevel {
        TIP,
        LOG,
        WARNING,
        ERROR,
        DEBUG
    }

    public ConsoleMessage(String message, String sourceId, int lineNumber, MessageLevel msgLevel) {
        this.mMessage = message;
        this.mSourceId = sourceId;
        this.mLineNumber = lineNumber;
        this.mLevel = msgLevel;
    }

    public String message() {
        return mMessage;
    }

    public String sourceId() {
        return mSourceId;
    }

    public int lineNumber() {
        return mLineNumber;
    }

    public MessageLevel messageLevel() {
        return mLevel;
    }
}
