import type { MutationQueue } from './mutationQueue';

// Box #11. Wires `online` + `focus` events to the queue's drain trigger.
export interface DrainTriggerOptions {
  queue: MutationQueue;
  windowTarget?: EventTarget | null;
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
  if (onAuthFlip) teardowns.push(onAuthFlip(drain));

  return () => {
    for (const t of teardowns) {
      try { t(); } catch { /* ignore */ }
    }
  };
}