package android.widget;

import android.content.Context;
import android.view.View;
import android.view.ViewGroup;
import java.util.Collection;
import java.util.List;

/**
 * ArrayAdapter stub —— 消除 fty 后台线程加载 android.widget.ArrayAdapter 的
 * NoClassDefFoundError 噪声。实现 ListAdapter；方法返回默认值（不抛异常）。
 */
public class ArrayAdapter<T> implements ListAdapter {

    public ArrayAdapter(Context context, int resource) { }
    public ArrayAdapter(Context context, int resource, int textViewResourceId) { }
    public ArrayAdapter(Context context, int resource, T[] objects) { }
    public ArrayAdapter(Context context, int resource, int textViewResourceId, T[] objects) { }
    public ArrayAdapter(Context context, int resource, List<T> objects) { }

    public int getCount() { return 0; }
    public Object getItem(int position) { return null; }
    public long getItemId(int position) { return 0; }
    public View getView(int position, View convertView, ViewGroup parent) { return null; }
    public int getItemViewType(int position) { return 0; }
    public int getViewTypeCount() { return 1; }
    public boolean hasStableIds() { return false; }
    public boolean isEmpty() { return true; }
    public View getDropDownView(int position, View convertView, ViewGroup parent) { return null; }
    public void setDropDownViewResource(int resource) { }
    public void setNotifyOnChange(boolean notifyOnChange) { }
    public void add(T object) { }
    public void addAll(T[] items) { }
    public void addAll(Collection<T> collection) { }
    public void clear() { }
    public void remove(T object) { }
    public void notifyDataSetChanged() { }
    public void notifyDataSetInvalidated() { }
    public Context getContext() { return null; }
    public T getItemTyped(int position) { return null; }
}