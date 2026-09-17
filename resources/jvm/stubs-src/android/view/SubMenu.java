package android.view;

/**
 * SubMenu stub —— 子菜单接口。
 */
public interface SubMenu extends Menu {

    SubMenu setHeaderTitle(int titleRes);

    SubMenu setHeaderTitle(CharSequence title);

    SubMenu setHeaderIcon(int iconRes);

    SubMenu setHeaderIcon(android.graphics.drawable.Drawable icon);

    SubMenu setHeaderView(View view);

    void clearHeader();

    SubMenu setIcon(android.graphics.drawable.Drawable icon);

    SubMenu setIcon(int iconRes);

    MenuItem getItem();
}
