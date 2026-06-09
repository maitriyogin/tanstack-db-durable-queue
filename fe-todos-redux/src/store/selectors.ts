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
  Object.keys(state.queue.ops).length;