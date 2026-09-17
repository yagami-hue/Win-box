package android.view;

/**
 * ContextMenu stub —— 上下文菜单接口。
 */
public interface ContextMenu extends Menu {

    ContextMenu setHeaderTitle(int titleRes);

    ContextMenu setHeaderTitle(CharSequence title);

    ContextMenu setHeaderIcon(int iconRes);

    ContextMenu setHeaderIcon(android.graphics.drawable.Drawable icon);

    ContextMenu setHeaderView(View view);

    void clearHeader();
}
