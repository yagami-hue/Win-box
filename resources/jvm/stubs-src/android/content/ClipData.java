package android.content;

import android.os.Parcel;
import android.os.Parcelable;

/**
 * ClipData stub —— 剪贴板数据载体。
 *
 * 真实调用面很窄（混淆工具库的 IPC 辅助类引用）。桌面版无系统剪贴板，
 * 但 ClipData 常作为方法参数类型出现，因此必须可构造、可 getItemAt。
 */
public class ClipData implements Parcelable {

    private final CharSequence label;
    private final java.util.List<Item> items = new java.util.ArrayList<Item>();

    public ClipData(CharSequence label, String[] mimeTypes, Item item) {
        this.label = label;
        if (item != null) {
            this.items.add(item);
        }
    }

    public ClipData(Item item) {
        this.label = null;
        if (item != null) {
            this.items.add(item);
        }
    }

    private ClipData(Parcel in) {
        this.label = null;
    }

    public static ClipData newPlainText(CharSequence label, CharSequence text) {
        return new ClipData(label, new String[]{"text/plain"}, new Item(text, null));
    }

    public static ClipData newHtmlText(CharSequence label, CharSequence text, String htmlText) {
        return new ClipData(label, new String[]{"text/html"}, new Item(text, htmlText));
    }

    public static ClipData newIntent(CharSequence label, Intent intent) {
        return new ClipData(label, new String[]{"text/plain"}, new Item((CharSequence) null, (String) null));
    }

    public static ClipData newUri(ContentResolver resolver, CharSequence label, android.net.Uri uri) {
        return new ClipData(label, new String[]{"text/plain"}, new Item(uri, "text/uri-list"));
    }

    public static ClipData newRawUri(CharSequence label, android.net.Uri uri) {
        return new ClipData(label, new String[]{"text/plain"}, new Item(uri, "text/uri-list"));
    }

    public CharSequence getLabel() {
        return label;
    }

    public int getItemCount() {
        return items.size();
    }

    public Item getItemAt(int index) {
        if (index < 0 || index >= items.size()) {
            return null;
        }
        return items.get(index);
    }

    public int getDescription() {
        return 0;
    }

    public String getDescriptionText() {
        return label == null ? null : label.toString();
    }

    // ---------------- Parcelable ----------------

    @Override
    public int describeContents() {
        return 0;
    }

    @Override
    public void writeToParcel(Parcel dest, int flags) {
    }

    public static final Creator<ClipData> CREATOR = new Creator<ClipData>() {
        @Override
        public ClipData createFromParcel(Parcel source) {
            return new ClipData(source);
        }

        @Override
        public ClipData[] newArray(int size) {
            return new ClipData[size];
        }
    };

    /** 单条剪贴内容 */
    public static class Item {

        private final CharSequence text;
        private final String htmlText;
        private final Intent intent;
        private final android.net.Uri uri;
        private final String mimeType;

        public Item(CharSequence text, String htmlText) {
            this.text = text;
            this.htmlText = htmlText;
            this.intent = null;
            this.uri = null;
            this.mimeType = "text/plain";
        }

        public Item(Intent intent, String mimeType) {
            this.text = null;
            this.htmlText = null;
            this.intent = intent;
            this.uri = null;
            this.mimeType = mimeType;
        }

        public Item(android.net.Uri uri, String mimeType) {
            this.text = null;
            this.htmlText = null;
            this.intent = null;
            this.uri = uri;
            this.mimeType = mimeType;
        }

        public CharSequence getText() {
            return text;
        }

        public String getHtmlText() {
            return htmlText;
        }

        public Intent getIntent() {
            return intent;
        }

        public android.net.Uri getUri() {
            return uri;
        }

        public String getMimeType() {
            return mimeType;
        }

        public CharSequence coerceToText(Context context) {
            return text;
        }

        public CharSequence coerceToStyledText(Context context) {
            return text;
        }

        public String coerceToHtmlText(Context context) {
            return htmlText;
        }
    }
}
