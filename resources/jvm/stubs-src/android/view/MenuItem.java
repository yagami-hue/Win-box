package android.view;

/**
 * MenuItem stub —— 菜单项接口。桌面版无菜单体系，只保留签名。
 */
public interface MenuItem {

    int getItemId();

    int getGroupId();

    int getOrder();

    MenuItem setTitle(CharSequence title);

    MenuItem setTitle(int title);

    CharSequence getTitle();

    MenuItem setTitleCondensed(CharSequence title);

    CharSequence getTitleCondensed();

    MenuItem setIcon(android.graphics.drawable.Drawable icon);

    MenuItem setIcon(int iconRes);

    MenuItem setCheckable(boolean checkable);

    boolean isCheckable();

    MenuItem setChecked(boolean checked);

    boolean isChecked();

    MenuItem setVisible(boolean visible);

    boolean isVisible();

    MenuItem setEnabled(boolean enabled);

    boolean isEnabled();

    MenuItem setOnMenuItemClickListener(OnMenuItemClickListener menuItemClickListener);

    interface OnMenuItemClickListener {
        boolean onMenuItemClick(MenuItem item);
    }
}
