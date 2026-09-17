package android.view;

import android.content.Context;

/** ContextWrapper stub（部分蜘蛛经它取 baseContext）。 */
public class ContextWrapper extends android.content.Context {
    protected Context mBase;

    public ContextWrapper(Context base) {
        this.mBase = base;
    }

    @Override public Context getApplicationContext() {
        return mBase != null ? mBase.getApplicationContext() : this;
    }
}
