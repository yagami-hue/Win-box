import { useEffect, useRef } from 'react';
import { makeHoverDelay } from './hoverDelay';

export function useHoverDelay(change: (open: boolean) => void) {
  const changeRef = useRef(change);
  changeRef.current = change;
  const delayRef = useRef<ReturnType<typeof makeHoverDelay> | null>(null);
  if (!delayRef.current) delayRef.current = makeHoverDelay(open => changeRef.current(open));
  const delay = delayRef.current;
  useEffect(() => () => delay.cancel(), [delay]);
  return delay;
}
