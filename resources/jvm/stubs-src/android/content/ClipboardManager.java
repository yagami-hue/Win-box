package android.content;

import android.content.ClipData;

/**
 * ClipboardManager stub —— 系统剪贴板。
 *
 * 桌面版无系统剪贴板：读返回 null（"剪贴板为空"），写丢弃。
 * 语义上等价于「用户没复制过东西」，是最不意外的降级。
 */
public class ClipboardManager {

    private ClipData primaryClip = null;

    public ClipboardManager() {
    }

    public ClipData getPrimaryClip() {
        return primaryClip;
    }

    public ClipData.Item getPrimaryClipItem() {
        return primaryClip == null ? null : primaryClip.getItemAt(0);
    }

    public CharSequence getText() {
        ClipData clip = primaryClip;
        if (clip == null || clip.getItemCount() == 0) {
            return null;
        }
        ClipData.Item item = clip.getItemAt(0);
        return item == null ? null : item.getText();
    }

    public boolean hasPrimaryClip() {
        return primaryClip != null;
    }

    public boolean hasText() {
        return getText() != null;
    }

    public void setPrimaryClip(ClipData clip) {
        this.primaryClip = clip;
    }

    public void clearPrimaryClip() {
        this.primaryClip = null;
    }

    public void addPrimaryClipChangedListener(OnPrimaryClipChangedListener listener) {
    }

    public void removePrimaryClipChangedListener(OnPrimaryClipChangedListener listener) {
    }

    public interface OnPrimaryClipChangedListener {
        void onPrimaryClipChanged();
    }
}
