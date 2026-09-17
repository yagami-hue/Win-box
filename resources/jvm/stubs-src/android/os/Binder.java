package android.os;

/**
 * Binder stub —— AIDL 生成类的基类。桌面版无跨进程通信，
 * transact/onTransact 一律返回 false（表示"不支持"），不抛异常以保持可加载。
 */
public class Binder implements IBinder {

    private String descriptor = "android.os.IBinder";

    public Binder() { }

    public Binder(String descriptor) { this.descriptor = descriptor; }

    @Override
    public String getInterfaceDescriptor() { return descriptor; }

    @Override
    public boolean pingBinder() { return false; }

    @Override
    public boolean isBinderAlive() { return false; }

    @Override
    public void linkToDeath(DeathRecipient recipient, int flags) { }

    @Override
    public boolean unlinkToDeath(DeathRecipient recipient, int flags) { return false; }

    @Override
    public boolean transact(int code, Parcel data, Parcel reply, int flags) { return false; }

    protected boolean onTransact(int code, Parcel data, Parcel reply, int flags) throws RemoteException {
        return false;
    }

    @Override
    public void dump(java.io.FileDescriptor fd, String[] args) { }

    @Override
    public void dumpAsync(java.io.FileDescriptor fd, String[] args) { }

    public void attachInterface(IInterface owner, String descriptor) {
        if (descriptor != null) this.descriptor = descriptor;
    }

    public IInterface queryLocalInterface(String descriptor) {
        return null;
    }

    public static final void writeNoException(Parcel reply) { }

    public static final void readExceptionFromParcel(Parcel reply) throws RemoteException { }

    public static final void readExceptionFromParcel(Parcel reply, int code, String msg) throws RemoteException { }
}
