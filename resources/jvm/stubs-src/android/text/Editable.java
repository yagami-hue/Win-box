package android.text;

/** Editable stub：无真实编辑框，返回自身/空即可（蜘蛛一般只用 isEmpty/toString）。 */
public interface Editable extends CharSequence {
    Editable replace(int st, int en, CharSequence text);
    Editable clear();
    boolean isEmpty();
}
