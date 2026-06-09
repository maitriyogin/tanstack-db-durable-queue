import { observable } from '@legendapp/state';
import { syncObservable } from '@legendapp/state/sync';
import { ObservablePersistLocalStorage } from '@legendapp/state/persist-plugins/local-storage';
import type { IdBinding, QueueOp, Todo } from './types';

// One observable for the whole local state. Three branches:
//   - todos.byId      — synced cache (server truth, written by useTodosQuery)
//   - queue.ops       — durable mutation queue (the optimistic overlay source)
//   - queue.bindings  — temp→server id map
//
// Anything mutated below this root is reactive: components read via
// `useValue()`, the runner reads via `.get()`, and the persist plugin
// writes the whole tree to localStorage on every change.
export const state$ = observable({
  todos: {
    byId: {} as Record<string, Todo>,
    status: 'idle' as 'idle' | 'loading' | 'success' | 'error',
    error: null as string | null,
  },
  queue: {
    ops: {} as Record<string, QueueOp>,
    bindings: {} as Record<string, IdBinding>,
    nextSeq: 0,
  },
});

// Persistence: sync the whole tree to localStorage. Hydrates synchronously
// on module load, then writes back on every change. The Legend State sync
// engine handles diff/throttle internally.
//
// Note: we deliberately are NOT using @legendapp/state/sync's `synced()` /
// `syncedCrud()` plugins for the GraphQL side. Those plugins own the queue
// (retry, persistence) but don't expose per-op idempotency keys, can't
// surface quarantined ops for a Retry/Discard UI, and don't reconcile
// temp→server ids. Our durable-queue runner does all three. So Legend
// State here is a state container + persistence; the runner owns ops.
syncObservable(state$, {
  persist: {
    name: 'fe-todos-legend:v1',
    plugin: ObservablePersistLocalStorage,
  },
});
