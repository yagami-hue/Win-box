package android.graphics;

import android.os.Parcel;
import android.os.Parcelable;

/**
 * Rect stub —— 矩形区域（纯数据结构）。
 *
 * ★ Braille 型纯数据类：必须功能完整。蜘蛛常用它做坐标裁剪计算，
 *   空壳会导致计算结果恒为 0。这里用真实的 int 字段实现。
 */
public class Rect implements Parcelable {

    public int left;
    public int top;
    public int right;
    public int bottom;

    public Rect() {
        this(0, 0, 0, 0);
    }

    public Rect(int left, int top, int right, int bottom) {
        this.left = left;
        this.top = top;
        this.right = right;
        this.bottom = bottom;
    }

    public Rect(Rect r) {
        if (r == null) {
            left = top = right = bottom = 0;
        } else {
            left = r.left;
            top = r.top;
            right = r.right;
            bottom = r.bottom;
        }
    }

    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof Rect)) return false;
        Rect r = (Rect) o;
        return left == r.left && top == r.top && right == r.right && bottom == r.bottom;
    }

    public int hashCode() {
        int result = left;
        result = 31 * result + top;
        result = 31 * result + right;
        result = 31 * result + bottom;
        return result;
    }

    public String toString() {
        return "Rect(" + left + ", " + top + ", " + right + ", " + bottom + ")";
    }

    public boolean isEmpty() {
        return left >= right || top >= bottom;
    }

    public int width() {
        return right - left;
    }

    public int height() {
        return bottom - top;
    }

    public int centerX() {
        return (left + right) >> 1;
    }

    public int centerY() {
        return (top + bottom) >> 1;
    }

    public float exactCenterX() {
        return (left + right) * 0.5f;
    }

    public float exactCenterY() {
        return (top + bottom) * 0.5f;
    }

    public void setEmpty() {
        left = right = top = bottom = 0;
    }

    public void set(int left, int top, int right, int bottom) {
        this.left = left;
        this.top = top;
        this.right = right;
        this.bottom = bottom;
    }

    public void set(Rect src) {
        if (src != null) set(src.left, src.top, src.right, src.bottom);
    }

    public void offset(int dx, int dy) {
        left += dx;
        top += dy;
        right += dx;
        bottom += dy;
    }

    public void offsetTo(int newLeft, int newTop) {
        right += newLeft - left;
        bottom += newTop - top;
        left = newLeft;
        top = newTop;
    }

    public void inset(int dx, int dy) {
        left += dx;
        top += dy;
        right -= dx;
        bottom -= dy;
    }

    public boolean contains(int x, int y) {
        return left < right && top < bottom && x >= left && x < right && y >= top && y < bottom;
    }

    public boolean contains(int left, int top, int right, int bottom) {
        return this.left < this.right && this.top < this.bottom
                && this.left <= left && this.top <= top
                && this.right >= right && this.bottom >= bottom;
    }

    public boolean contains(Rect r) {
        return r != null && contains(r.left, r.top, r.right, r.bottom);
    }

    public boolean intersect(int left, int top, int right, int bottom) {
        if (this.left < right && left < this.right && this.top < bottom && top < this.bottom) {
            if (this.left < left) this.left = left;
            if (this.top < top) this.top = top;
            if (this.right > right) this.right = right;
            if (this.bottom > bottom) this.bottom = bottom;
            return true;
        }
        return false;
    }

    public boolean intersect(Rect r) {
        return r != null && intersect(r.left, r.top, r.right, r.bottom);
    }

    public void union(int x, int y) {
        if (x < left) left = x;
        else if (x > right) right = x;
        if (y < top) top = y;
        else if (y > bottom) bottom = y;
    }

    public void union(Rect r) {
        if (r != null) union(r.left, r.top, r.right, r.bottom);
    }

    public void union(int left, int top, int right, int bottom) {
        if (left < right && top < bottom) {
            if (this.left < this.right && this.top < this.bottom) {
                if (this.left > left) this.left = left;
                if (this.top > top) this.top = top;
                if (this.right < right) this.right = right;
                if (this.bottom < bottom) this.bottom = bottom;
            } else {
                this.left = left;
                this.top = top;
                this.right = right;
                this.bottom = bottom;
            }
        }
    }

    public void sort() {
        if (left > right) {
            int tmp = left;
            left = right;
            right = tmp;
        }
        if (top > bottom) {
            int tmp = top;
            top = bottom;
            bottom = tmp;
        }
    }

    public void scale(float scale) {
        if (scale != 1.0f) {
            left = (int) (left * scale + 0.5f);
            top = (int) (top * scale + 0.5f);
            right = (int) (right * scale + 0.5f);
            bottom = (int) (bottom * scale + 0.5f);
        }
    }

    public static boolean intersects(Rect a, Rect b) {
        return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    }

    @Override
    public int describeContents() {
        return 0;
    }

    @Override
    public void writeToParcel(Parcel out, int flags) {
        out.writeInt(left);
        out.writeInt(top);
        out.writeInt(right);
        out.writeInt(bottom);
    }

    public static final Creator<Rect> CREATOR = new Creator<Rect>() {
        @Override
        public Rect createFromParcel(Parcel in) {
            Rect r = new Rect();
            r.left = in.readInt();
            r.top = in.readInt();
            r.right = in.readInt();
            r.bottom = in.readInt();
            return r;
        }

        @Override
        public Rect[] newArray(int size) {
            return new Rect[size];
        }
    };
}
