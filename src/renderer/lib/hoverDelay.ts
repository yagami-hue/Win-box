/** Trigger and panel share a delay, so crossing their gap does not close the panel. */
export function makeHoverDelay(change: (open: boolean) => void, openMs = 250, closeMs = 300) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (timer != null) clearTimeout(timer);
    timer = null;
  };
  return {
    enter(immediate = false) {
      cancel();
      if (immediate) change(true);
      else timer = setTimeout(() => { timer = null; change(true); }, openMs);
    },
    leave() {
      cancel();
      timer = setTimeout(() => { timer = null; change(false); }, closeMs);
    },
    cancel,
  };
}
