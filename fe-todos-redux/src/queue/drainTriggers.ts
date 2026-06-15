import type { MutationRunner } from './runner';

export interface DrainTriggerOptions {
  runner: MutationRunner;
  windowTarget?: EventTarget | null;
  onAuthFlip?: (cb: () => void) => () => void;
}

export function attachDrainTriggers(opts: DrainTriggerOptions): () => void {
  const { runner, onAuthFlip } = opts;
  const target =
    opts.windowTarget === null
      ? null
      : opts.windowTarget ??
        (typeof globalThis !== 'undefined' ? (globalThis as EventTarget) : null);

  const fire = () => runner.triggerDrain();
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
