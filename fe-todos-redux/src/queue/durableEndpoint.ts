import type { Store } from '@reduxjs/toolkit';
import { queueActions } from './queueSlice';
import { recordHandle, makeDeferred } from './handles';
import { runner } from './runner';
import type { QueueOpRow, QueueOpType } from './types';

export interface PatchHandle {
  undo: () => void;
}

export interface OptimisticPatchSource {
  // A function that runs the optimistic update against the cache and returns
  // a patch handle whose `.undo()` reverts it. Typically returns the result
  // of `dispatch(api.util.updateQueryData(...))` (which has shape
  // `{ patches, inversePatches, undo }`).
  apply: () => PatchHandle;
}

export interface EnqueueOptions {
  // Stamped on the row. Default: `${collectionId}:${resolveServerId(key)}` —
  // this lets pre-bind temp ops group with their post-bind insert.
  correlationKey?: string;
  optimistic?: OptimisticPatchSource[];
}

export interface EnqueueResult {
  opId: string;
  completion: Promise<void>;
}

export function enqueueMutation(
  store: Store,
  collectionId: string,
  type: QueueOpType,
  key: string,
  payload: QueueOpRow['payload'],
  options: EnqueueOptions = {},
): EnqueueResult {
  const opId = crypto.randomUUID();
  const correlationKey =
    options.correlationKey ?? `${collectionId}:${runner.resolveServerId(collectionId, key)}`;

  // 1) Apply optimistic patches FIRST so the next render shows the row.
  const deferred = makeDeferred();
  const patches: PatchHandle[] = [];
  if (options.optimistic) {
    for (const source of options.optimistic) {
      try {
        patches.push(source.apply());
      } catch (e) {
        console.warn('[durableQueue] optimistic apply threw:', e);
      }
    }
  }
  recordHandle(opId, {
    patches,
    deferred: { resolve: deferred.resolve, reject: deferred.reject },
    quarantined: false,
  });

  // 2) Persist the queue row.
  const row: Omit<QueueOpRow, 'seq'> = {
    id: opId,
    collectionId,
    type,
    key,
    payload,
    enqueuedAt: Date.now(),
    attempts: 0,
    status: 'pending',
    correlationKey,
    nextAttemptAt: null,
  };
  store.dispatch(queueActions.enqueueOp(row));

  // 3) Kick the runner.
  runner.triggerDrain();

  return { opId, completion: deferred.promise };
}