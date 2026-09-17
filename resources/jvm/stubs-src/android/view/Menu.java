package android.view;

/**
 * Menu stub —— 菜单接口。桌面版无菜单体系，只保留签名。
 */
public interface Menu {

    int NONE = 0;
    int FIRST = 1;
    int CATEGORY_CONTAINER = 0x00010000;
    int CATEGORY_SYSTEM = 0x00020000;
    int CATEGORY_SECONDARY = 0x00030000;
    int CATEGORY_ALTERNATIVE = 0x00040000;

    MenuItem add(CharSequence title);

    MenuItem add(int titleRes);

    MenuItem add(int groupId, int itemId, int order, CharSequence title);

    MenuItem add(int groupId, int itemId, int order, int titleRes);

    SubMenu addSubMenu(CharSequence title);

    SubMenu addSubMenu(int titleRes);

    SubMenu addSubMenu(int groupId, int itemId, int order, CharSequence title);

    SubMenu addSubMenu(int groupId, int itemId, int order, int titleRes);

    MenuItem findItem(int id);

    int size();

    MenuItem getItem(int index);

    void removeItem(int id);

    void removeGroup(int groupId);

    void clear();

    void close();

    boolean hasVisibleItems();

    boolean performIdentifierAction(int id, int flags);

    void setQwertyMode(boolean isQwerty);
}
