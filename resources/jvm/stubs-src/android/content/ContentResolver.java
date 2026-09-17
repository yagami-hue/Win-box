package android.content;

/**
 * ContentResolver stub —— 跨进程内容提供者访问入口。
 *
 * 桌面版无 ContentProvider 体系：所有查询返回 null / 空游标，
 * openInputStream 返回 null（调用方会走"读不到数据"分支）。
 * 这是最安全的降级：不会抛异常打断蜘蛛主流程。
 */
public class ContentResolver {

    public static final String SCHEME_CONTENT = "content";
    public static final String SCHEME_ANDROID_RESOURCE = "android.resource";
    public static final String SCHEME_FILE = "file";
    public static final String SCHEME_HTTP = "http";
    public static final String SCHEME_HTTPS = "https";

    private final Context context;

    /** 无参构造 —— 供 Context.getContentResolver() 直接 new（瓜子 Appgz 等蜘蛛 init 阶段调用） */
    public ContentResolver() {
        this(null);
    }

    public ContentResolver(Context context) {
        this.context = context;
    }

    public Context getContext() {
        return context;
    }

    public android.database.Cursor query(android.net.Uri uri, String[] projection,
                                         String selection, String[] selectionArgs, String sortOrder) {
        return null;
    }

    public String getType(android.net.Uri url) {
        return null;
    }

    public android.net.Uri insert(android.net.Uri url, ContentValues values) {
        return null;
    }

    public int delete(android.net.Uri url, String where, String[] selectionArgs) {
        return 0;
    }

    public int update(android.net.Uri uri, ContentValues values, String where, String[] selectionArgs) {
        return 0;
    }

    public java.io.InputStream openInputStream(android.net.Uri uri) {
        return null;
    }

    public java.io.OutputStream openOutputStream(android.net.Uri uri) {
        return null;
    }

    public java.io.FileDescriptor openFileDescriptor(android.net.Uri uri, String mode) {
        return null;
    }
}
