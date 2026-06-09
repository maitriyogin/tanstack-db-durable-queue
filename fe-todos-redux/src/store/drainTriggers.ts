import type { MutationQueue } from './mutationQueue';

// Box #11: opt-in helper that wires `online` / `focus` events to the
// queue's drain trigger. Auth-flip is caller-supplied because there's no
// standard event for it. Returns a teardown function so tests / HMR can
// unwire cleanly.
export interface DrainTriggerOptions {
  queue: MutationQueue;
  // Defaults to `globalThis` in browsers; pass `null` to skip wiring
  // window-level events (useful in non-browser test runs).
  windowTarget?: EventTarget | null;
  // Caller supplies a subscribe function for "the auth state just
  // changed" — drain when that fires too. Returns its unsubscribe.
  onAuthFlip?: (drain: () => void) => () => void;
}

export function attachDrainTriggers(opts: DrainTriggerOptions): () => void {
  const { queue, onAuthFlip } = opts;
  const target =
    opts.windowTarget === undefined ? (globalThis as EventTarget) : opts.windowTarget;
  const drain = () => queue.triggerDrain();

  const teardowns: Array<() => void> = [];

  if (target) {
    target.addEventListener('online', drain);
    target.addEventListener('focus', drain);
    teardowns.push(() => {
      target.removeEventListener('online', drain);
      target.removeEventListener('focus', drain);
    });
  }
  if (onAuthFlip) {
    teardowns.push(onAuthFlip(drain));
  }

  return () => {
    for (const t of teardowns) {
      try {
        t();
      } catch {
        // ignore
      }
    }
  };
}
