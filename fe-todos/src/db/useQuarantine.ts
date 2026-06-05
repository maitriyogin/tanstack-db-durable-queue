import { useSyncExternalStore } from 'react';
import { mutationQueue } from './persistence';
import type { QueueOp } from './mutationQueue';

// React hook returning the current quarantine list, scoped to a single
// collection. Re-renders when ops enter or leave quarantine.
//
// Implementation note: we deliberately do NOT subscribe at module-load time.
// `persistence.ts` does a top-level `await` to open the OPFS database, so
// modules that import from it can run before that awaited initialization
// completes — touching `mutationQueue` then can throw. Subscribing lazily
// (inside the hook's `subscribe` callback, which React only invokes during
// render) sidesteps that ordering hazard.

let revision = 0;
let bumperSubscribed = false;
function ensureBumperSubscribed() {
  if (bumperSubscribed) return;
  bumperSubscribed = true;
  mutationQueue.subscribeQuarantine(() => {
    revision++;
  });
}

const cache = new Map<string, { rev: number; value: Array<QueueOp> }>();

function getCachedQuarantineFor(collectionId: string): Array<QueueOp> {
  const cached = cache.get(collectionId);
  if (cached && cached.rev === revision) return cached.value;
  const next = mutationQueue
    .quarantineList()
    .filter((op) => op.collectionId === collectionId);
  cache.set(collectionId, { rev: revision, value: next });
  return next;
}

export function useQuarantineFor(collectionId: string): Array<QueueOp> {
  return useSyncExternalStore(
    (listener) => {
      ensureBumperSubscribed();
      return mutationQueue.subscribeQuarantine(listener);
    },
    () => getCachedQuarantineFor(collectionId),
    () => [],
  );
}
