package android.annotation;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * TargetApi 注解 stub。
 *
 * <p>★ 这是**注解**，必须声明为 {@code @Retention(RUNTIME)} 且真实存在：
 * 蜘蛛产物里 {@code @TargetApi(21)} 会写进 class 的 RuntimeVisibleAnnotations，
 * 运行期反射读取时若类不存在，JVM 抛的是 TypeNotPresentException —— 比
 * ClassNotFoundException 更难定位（栈里只有 Class.getAnnotations）。
 */
@Retention(RetentionPolicy.RUNTIME)
@Target({ElementType.TYPE, ElementType.METHOD, ElementType.CONSTRUCTOR, ElementType.FIELD})
public @interface TargetApi {
    int value();
}
