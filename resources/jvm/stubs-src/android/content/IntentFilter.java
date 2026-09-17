package android.content;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * IntentFilter stub —— Intent 过滤器（registerReceiver 的参数）。
 *
 * 纯数据：记录 action/category，match 恒返回 false（桌面版无广播系统，
 * 「不匹配」语义比误匹配更安全）。
 */
public class IntentFilter {

    private final List<String> actions = new ArrayList<String>();
    private final List<String> categories = new ArrayList<String>();
    private final List<String> schemes = new ArrayList<String>();
    private int priority = 0;

    public IntentFilter() {
    }

    public IntentFilter(String action) {
        addAction(action);
    }

    public IntentFilter(String action, String dataType) {
        addAction(action);
        addDataType(dataType);
    }

    public final void addAction(String action) {
        if (action != null && !actions.contains(action)) {
            actions.add(action);
        }
    }

    public final void addCategory(String category) {
        if (category != null && !categories.contains(category)) {
            categories.add(category);
        }
    }

    public final void addDataType(String type) {
    }

    public final void addDataScheme(String scheme) {
        if (scheme != null) {
            schemes.add(scheme);
        }
    }

    public final void addDataAuthority(String host, String port) {
    }

    public final void addDataPath(String path, int type) {
    }

    public final int countActions() {
        return actions.size();
    }

    public final String getAction(int index) {
        return index >= 0 && index < actions.size() ? actions.get(index) : null;
    }

    public final boolean hasAction(String action) {
        return actions.contains(action);
    }

    public final int countCategories() {
        return categories.size();
    }

    public final String getCategory(int index) {
        return index >= 0 && index < categories.size() ? categories.get(index) : null;
    }

    public final boolean hasCategory(String category) {
        return categories.contains(category);
    }

    public final Set<String> categories() {
        return new HashSet<String>(categories);
    }

    public final int countDataSchemes() {
        return schemes.size();
    }

    public final String getDataScheme(int index) {
        return index >= 0 && index < schemes.size() ? schemes.get(index) : null;
    }

    public void setPriority(int priority) {
        this.priority = priority;
    }

    public final int getPriority() {
        return priority;
    }

    /** 桌面版无广播系统：「不匹配」恒成立，调用方会跳过后续处理 */
    public final boolean match(String action, String type, String scheme, android.net.Uri data,
                               Set<String> categories, String logTag) {
        return false;
    }

    public final boolean match(android.content.ContentResolver resolver, Intent intent,
                               boolean resolve, String logTag) {
        return false;
    }

    public final boolean matchAction(String action) {
        return hasAction(action);
    }

    public final boolean hasExactDataType() {
        return false;
    }

    public String toString() {
        return "IntentFilter{actions=" + actions + ", categories=" + categories + "}";
    }
}
