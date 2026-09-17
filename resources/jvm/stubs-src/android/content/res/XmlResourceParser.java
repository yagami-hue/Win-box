package android.content.res;

/**
 * XmlResourceParser stub —— 解析编译后的 XML 资源（aapt 产物的二进制格式）。
 *
 * <p>真实调用面（扫描确认，merge/q/c）：作为 {@code getXml(int)} 的返回类型
 * 以及 {@code AttributeSet} 的实现被传递。桌面端没有资源编译产物，
 * 该类只需要"类型存在 + 方法可调用"。
 *
 * <p>★ 关键约束：必须 extends {@code android.util.AttributeSet}——内嵌库会把
 * XmlResourceParser 当 AttributeSet 传给 View 构造器（字节码里是
 * {@code checkcast android/util/AttributeSet}），接口链断了就 VerifyError。
 *
 * <p>★ 注意 {@code getPositionDescription()} 的返回类型由父接口决定（String），
 * 与安卓原版的 int 版本不同名不同签名——这里**不能**重复声明，否则冲突。
 */
public interface XmlResourceParser extends android.util.AttributeSet, java.io.Closeable {

    void close();

    String getAttributeNamespace(int index);

    int next();

    int nextToken();

    int getEventType();

    int getDepth();

    int getLineNumber();

    String getName();

    String getText();

    boolean isEmpty();

    void setFeature(String name, boolean state);

    boolean getFeature(String name);

    java.util.List<Object> getAttributeNames();
}
