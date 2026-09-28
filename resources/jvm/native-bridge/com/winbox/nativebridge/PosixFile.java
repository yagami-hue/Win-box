package com.winbox.nativebridge;

import java.io.File;
import java.io.IOException;

/**
 * 来宾侧专用 java.io.File —— **路径串保持 POSIX 形态，真实 IO 映射到 unidbg 来宾 FS 的 rootfs**。
 *
 * 为什么必须这样（Spike 实测结论，勿改）：
 *  ① 原生代码会把 Java 侧给的路径**直接交给 openat/mkdir 等系统调用**；unidbg 的来宾 FS 用
 *     `new File(rootDir, pathname)` 映射，若 pathname 是宿主机 Windows 路径（`e:\...`），
 *     拼出来的路径带盘符冒号 → `createNewFile failed: <rootfs>\e:\...` 直接炸，守卫 register() 中断。
 *  ② 因此路径串必须是 POSIX 来宾路径（如 `/data/data/<pkg>/files`），而 exists()/mkdirs()/… 等
 *     真正落盘的操作要跟来宾 FS 对齐（同一个 rootfs 下的主机路径），两边语义一致才不打架。
 */
public class PosixFile extends File {

    /** unidbg 来宾 FS 的宿主根（= emulator.getFileSystem().getRootDir()），由 NativeBridge 注入 */
    private static volatile File rootfs;

    public static void setRootfs(File dir) {
        rootfs = dir;
    }

    /**
     * ★ 2026-09-27（壳通解）：把「来宾 POSIX 路径」解析成宿主真实文件，供 dex 加载器读取壳的落盘产物。
     * 宿主路径原样可读时直接用它；否则按「rootfs + 来宾路径」映射。找不到返回原 File（调用方自行判存在）。
     */
    public static File resolveHost(String path) {
        File f = new File(path);
        if (f.isFile()) return f;
        File r = rootfs;
        if (r == null) return f;
        String p = path == null ? "" : path.replace('\\', '/');
        if (!p.startsWith("/")) p = "/" + p;
        File g = new File(r, p);
        return g.isFile() ? g : f;
    }

    private final String posix;

    public PosixFile(String pathname) {
        super(pathname);
        this.posix = pathname;
    }

    public PosixFile(String parent, String child) {
        super(parent, child);
        this.posix = parent + "/" + child;
    }

    public PosixFile(File parent, String child) {
        super(parent, child);
        this.posix = (parent == null ? "" : parent.getPath()) + "/" + child;
    }

    /** 真实落盘的宿主位置（= 来宾 FS 对同一来宾路径的映射） */
    private File host() {
        File r = rootfs;
        return r == null ? this : new File(r, posix);
    }

    @Override
    public String getPath() {
        return posix;
    }

    @Override
    public String getAbsolutePath() {
        return posix;
    }

    @Override
    public String getCanonicalPath() {
        return posix;
    }

    @Override
    public File getParentFile() {
        int i = posix.lastIndexOf('/');
        return i > 0 ? new PosixFile(posix.substring(0, i)) : null;
    }

    @Override
    public String getName() {
        int i = posix.lastIndexOf('/');
        return i < 0 ? posix : posix.substring(i + 1);
    }

    @Override
    public boolean exists() {
        return host().exists();
    }

    @Override
    public boolean isDirectory() {
        return host().isDirectory();
    }

    @Override
    public boolean isFile() {
        return host().isFile();
    }

    @Override
    public boolean mkdirs() {
        return host().mkdirs();
    }

    @Override
    public boolean mkdir() {
        return host().mkdir();
    }

    @Override
    public boolean createNewFile() {
        File h = host();
        if (h.getParentFile() != null) h.getParentFile().mkdirs();
        try {
            return h.createNewFile();
        } catch (IOException e) {
            return false;
        }
    }

    @Override
    public long length() {
        return host().length();
    }

    @Override
    public boolean delete() {
        return host().delete();
    }

    @Override
    public File[] listFiles() {
        File[] list = host().listFiles();
        if (list == null) return null;
        File[] out = new File[list.length];
        for (int i = 0; i < list.length; i++) {
            out[i] = new PosixFile(posix + "/" + list[i].getName());
        }
        return out;
    }

    @Override
    public String toString() {
        return posix;
    }
}