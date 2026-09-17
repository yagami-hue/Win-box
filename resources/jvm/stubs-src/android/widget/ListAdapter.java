package android.widget;

import android.view.View;
import android.view.ViewGroup;

/**
 * ListAdapter stub —— 消除 fty 后台线程加载 android.widget.ListAdapter 时的
 * NoClassDefFoundError 噪声。保持为 interface（调用方按 invokeinterface 使用）。
 * 未继承 android.widget.Adapter（该接口 stub 未提供，避免引入缺失类型）。
 */
public interface ListAdapter {
    int getCount();
    Object getItem(int position);
    long getItemId(int position);
    View getView(int position, View convertView, ViewGroup parent);
    int getItemViewType(int position);
    int getViewTypeCount();
    boolean hasStableIds();
    boolean isEmpty();
    View getDropDownView(int position, View convertView, ViewGroup parent);
}