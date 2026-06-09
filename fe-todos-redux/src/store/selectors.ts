import { createSelector } from '@reduxjs/toolkit';
import type { RootState } from './store';
import type { QueueOp, Todo } from './types';

// The optimistic overlay. TanStack DB does this internally; here we compute
// it in a memoized selector. Order matters: synced cache first, then ops in
// queue order (seq ascending) layered on top.
//
//   insert → adds the row at its temp id
//   update → patches the row (synced or already-optimistic)
//   delete → removes the row
//
// Components read from this selector, never from `state.todos.byId` directly.
// That's the contract that keeps optimistic work visible until the queue
// settles, even when a refetch lands.
const selectTodosById = (state: RootState) => state.todos.byId;
const selectQueueOps = (state: RootState) => state.queue.ops;

export const selectTodos = createSelector(
  [selectTodosById, selectQueueOps],
  (byId, ops): Todo[] => {
    // Start from a copy of synced state (so we can mutate freely without
    // tripping immer or returning stale references).
    const overlay: Record<string, Todo> = { ...byId };
    const queue = Object.values(ops)
      .filter((op): op is QueueOp<Todo> => op.collectionId === 'todos')
      .sort((a, b) => a.seq - b.seq);
    for (const op of queue) {
      if (op.type === 'insert') {
        const next = op.payload.modified;
        if (next) overlay[op.key] = next;
      } else if (op.type === 'update') {
        const existing = overlay[op.key];
        const next = op.payload.modified;
        if (existing && next) overlay[op.key] = { ...existing, ...next };
        else if (next) overlay[op.key] = next;
      } else {
        delete overlay[op.key];
      }
    }
    return Object.values(overlay).sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
    );
  },
);

export const selectTodosStatus = (state: RootState) => state.todos.status;
export const selectTodosError = (state: RootState) => state.todos.error;
export const selectQueueDepth = (state: RootState) =>
  Object.values(state.queue.ops).filter((op) => op.status !== 'quarantined').length;

// Box #9: list of ops parked in quarantine for a given collection. The UI
// reads this to render Failed/Retry/Discard affordances.
export const makeSelectQuarantineFor = (collectionId: string) =>
  createSelector(
    [(state: RootState) => state.queue.ops],
    (ops) =>
      Object.values(ops).filter(
        (op) =>
          op.collectionId === collectionId && op.status === 'quarantined',
      ),
  );

// Box #4: render-key alias. When a row's id is a server id and we have a
// binding for it, return the original temp id. Components key React lists
// off this so a row doesn't unmount when the underlying id flips temp→
// server. When there's no binding for the input, return it unchanged.
export function aliasForKey(
  state: RootState,
  collectionId: string,
  key: string,
): string {
  for (const b of Object.values(state.queue.bindings)) {
    if (b.collectionId === collectionId && b.serverId === key) return b.tempId;
  }
  return key;
}