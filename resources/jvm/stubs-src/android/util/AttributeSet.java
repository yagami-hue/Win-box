package android.util;

/**
 * AttributeSet stub —— XML 属性集合（布局 inflate 时用）。
 * 桌面版不做布局解析：所有查询返回默认值。
 */
public interface AttributeSet {

    int getAttributeCount();

    String getAttributeName(int index);

    String getAttributeValue(int index);

    String getAttributeValue(String namespace, String name);

    int getAttributeNameResource(int index);

    int getAttributeListValue(String namespace, String attribute, String[] options, int defaultValue);

    boolean getAttributeBooleanValue(String namespace, String attribute, boolean defaultValue);

    int getAttributeResourceValue(String namespace, String attribute, int defaultValue);

    int getAttributeIntValue(String namespace, String attribute, int defaultValue);

    int getAttributeUnsignedIntValue(String namespace, String attribute, int defaultValue);

    float getAttributeFloatValue(String namespace, String attribute, float defaultValue);

    String getIdAttribute();

    String getClassAttribute();

    int getIdAttributeResourceValue(int defaultValue);

    int getStyleAttribute();

    int getPositionDescription();
}
