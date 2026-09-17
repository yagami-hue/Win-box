package android.view;

/**
 * ViewParent stub —— 视图树父节点接口。
 * 桌面版无 UI 树：所有查询返回 false / null。
 */
public interface ViewParent {

    ViewParent getParent();

    void requestLayout();

    boolean isLayoutRequested();

    void requestDisallowInterceptTouchEvent(boolean disallowIntercept);

    void invalidateChild(View child, android.graphics.Rect dirty);

    ViewParent invalidateChildInParent(int[] location, android.graphics.Rect dirty);

    boolean getChildVisibleRect(View child, android.graphics.Rect r, android.graphics.Point offset);

    void bringChildToFront(View child);

    boolean showContextMenuForChild(View originalView);

    void createContextMenu(ContextMenu menu);

    void focusableViewAvailable(View v);

    boolean canResolveLayoutDirection();

    void requestChildFocus(View child, View focused);

    void clearChildFocus(View child);

    View focusSearch(View v, int direction);

    void childHasTransientStateChanged(View child, boolean hasTransientState);
}
