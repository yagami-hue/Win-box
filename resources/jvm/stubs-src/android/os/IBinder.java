package android.os;

/**
 * IBinder stub —— 进程间通信句柄。桌面版无 Binder 机制，仅需类型存在。
 * Android 里它是接口，且定义了一组常量（FIRST_CALL_TRANSACTION 等），
 * AIDL 生成的代码会引用这些常量。
 */
public interface IBinder {

    int FIRST_CALL_TRANSACTION = 0x00000001;
    int LAST_CALL_TRANSACTION = 0x00ffffff;
    int PING_TRANSACTION = ('_' << 24) | ('P' << 16) | ('N' << 8) | 'G';
    int DUMP_TRANSACTION = ('_' << 24) | ('D' << 16) | ('M' << 8) | 'P';
    int INTERFACE_TRANSACTION = ('_' << 24) | ('N' << 16) | ('T' << 8) | 'F';
    int TWEET_TRANSACTION = ('_' << 24) | ('T' << 16) | ('W' << 8) | 'T';
    int LIKE_TRANSACTION = ('_' << 24) | ('L' << 16) | ('I' << 8) | 'K';

    String getInterfaceDescriptor();
    boolean pingBinder();
    boolean isBinderAlive();
    void linkToDeath(DeathRecipient recipient, int flags);
    boolean unlinkToDeath(DeathRecipient recipient, int flags);
    boolean transact(int code, Parcel data, Parcel reply, int flags);
    void dump(java.io.FileDescriptor fd, String[] args);
    void dumpAsync(java.io.FileDescriptor fd, String[] args);

    interface DeathRecipient {
        void binderDied();
    }
}
