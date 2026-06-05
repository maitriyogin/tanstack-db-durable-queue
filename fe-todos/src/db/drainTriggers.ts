import type { MutationQueue } from './mutationQueue';

// Box #11: opt-in browser triggers. Call this once during app boot to wire
// the queue runner up to network/window/auth events. Returns a teardown
// function for tests and HMR.
//
// All triggers funnel through `queue.triggerDrain()`, which is mutex-coalesced
// inside the runner, so concurrent fires (focus + reconnect + auth flip in
// the same tick) drain at most one extra pass.
export interface DrainTriggerOptions {
  queue: MutationQueue;
  // EventTargets to listen on. Defaults to `globalThis` for browsers; pass
  // explicit targets in non-browser environments. Pass `null` to skip a
  // particular trigger.
  windowTarget?: EventTarget | null;
  // An async callback consumers invoke whenever auth state flips (login,
  // logout, token refresh that re-enables writes). Returned cleanup
  // unregisters the listener.
  onAuthFlip?: (cb: () => void) => () => void;
}

export function attachDrainTriggers(opts: DrainTriggerOptions) {
  const { queue, onAuthFlip } = opts;
  const target =
    opts.windowTarget === null
      ? null
      : opts.windowTarget ?? (typeof globalThis !== 'undefined' ? (globalThis as EventTarget) : null);

  const fire = () => queue.triggerDrain();
  const cleanups: Array<() => void> = [];

  if (target) {
    target.addEventListener('online', fire);
    target.addEventListener('focus', fire);
    cleanups.push(() => target.removeEventListener('online', fire));
    cleanups.push(() => target.removeEventListener('focus', fire));
  }

  if (onAuthFlip) {
    cleanups.push(onAuthFlip(fire));
  }

  return () => {
    for (const c of cleanups) c();
  };
}