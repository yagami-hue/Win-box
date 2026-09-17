package android.graphics;

/**
 * Point stub —— 二维整数点（纯数据结构，必须功能完整）。
 */
public class Point implements android.os.Parcelable {

    public int x;
    public int y;

    public Point() {
        this(0, 0);
    }

    public Point(int x, int y) {
        this.x = x;
        this.y = y;
    }

    public Point(Point src) {
        if (src != null) {
            this.x = src.x;
            this.y = src.y;
        }
    }

    public void set(int x, int y) {
        this.x = x;
        this.y = y;
    }

    public final void negate() {
        x = -x;
        y = -y;
    }

    public final void offset(int dx, int dy) {
        x += dx;
        y += dy;
    }

    public final boolean equals(int x, int y) {
        return this.x == x && this.y == y;
    }

    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof Point)) return false;
        Point p = (Point) o;
        return x == p.x && y == p.y;
    }

    public int hashCode() {
        return 31 * x + y;
    }

    public String toString() {
        return "Point(" + x + ", " + y + ")";
    }

    @Override
    public int describeContents() {
        return 0;
    }

    @Override
    public void writeToParcel(android.os.Parcel out, int flags) {
        out.writeInt(x);
        out.writeInt(y);
    }

    public static final Creator<Point> CREATOR = new Creator<Point>() {
        @Override
        public Point createFromParcel(android.os.Parcel in) {
            Point p = new Point();
            p.x = in.readInt();
            p.y = in.readInt();
            return p;
        }

        @Override
        public Point[] newArray(int size) {
            return new Point[size];
        }
    };
}
