import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeHoverDelay } from '../src/renderer/lib/hoverDelay';

afterEach(() => vi.useRealTimers());
describe('player hover delay', () => {
  it('does not open while merely passing over the trigger', () => {
    vi.useFakeTimers();
    const change = vi.fn();
    const hover = makeHoverDelay(change);
    hover.enter();
    vi.advanceTimersByTime(100);
    hover.leave();
    vi.advanceTimersByTime(300);
    expect(change.mock.calls).toEqual([[false]]);
  });
  it('opens after 250ms and closes only after leaving for 300ms', () => {
    vi.useFakeTimers();
    const change = vi.fn();
    const hover = makeHoverDelay(change);
    hover.enter();
    vi.advanceTimersByTime(249);
    expect(change).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(change).toHaveBeenLastCalledWith(true);
    hover.leave();
    vi.advanceTimersByTime(299);
    expect(change).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(change).toHaveBeenLastCalledWith(false);
  });
  it('crossing the gap into the panel cancels the pending close', () => {
    vi.useFakeTimers();
    const change = vi.fn();
    const hover = makeHoverDelay(change);
    hover.enter();
    vi.advanceTimersByTime(250);
    hover.leave();
    vi.advanceTimersByTime(150);
    hover.enter(true);
    vi.advanceTimersByTime(1000);
    expect(change.mock.calls.every(call => call[0])).toBe(true);
  });
  it('cancels outstanding work on unmount or when another trigger takes over', () => {
    vi.useFakeTimers();
    const change = vi.fn();
    const hover = makeHoverDelay(change);
    hover.enter();
    hover.cancel();
    vi.runAllTimers();
    expect(change).not.toHaveBeenCalled();
  });
});
