import { observable } from '@legendapp/state';
import { syncObservable } from '@legendapp/state/sync';
import { observablePersistSqlite } from '@legendapp/state/persist-plugins/expo-sqlite';
import Storage from 'expo-sqlite/kv-store';
import type { IdBinding, QueueOp, Todo } from './types';

// One observable for the whole local state — same shape as fe-todos-legend.
// The expo-sqlite plugin uses the kv-store API: a single SQLite database
// where Legend State stores observable branches as JSON blobs keyed by
// table name. Durable across reloads, fast (SQLite is happy with this
// access pattern), and survives both background termination and OS-level
// process kills.
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

// Returns the sync handle so callers can await `isPersistLoaded` before
// doing anything that depends on hydrated state. expo-sqlite's plugin is
// async — unlike fe-todos-legend's localStorage variant, our cold-boot
// sweep can't run until rehydration finishes.
export const syncHandle = syncObservable(state$, {
  persist: {
    name: 'fe-todos-expo:v1',
    plugin: observablePersistSqlite(Storage),
  },
});
