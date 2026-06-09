import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { IdBinding, QueueOp } from './types';

// One row per queued op; one row per id binding. Kept in normalized objects
// keyed by id rather than arrays so updates are O(1) and selector identity
// works under react-redux's shallow check.
//
// `nextSeq` is the per-store monotonic counter — replaces TanStack DB's
// in-memory `nextSeq++` in mutationQueue.ts. Persisted alongside the rows
// so that after a reload, brand-new ops still come *after* persisted ones.
export interface QueueState {
  ops: Record<string, QueueOp>;
  bindings: Record<string, IdBinding>;
  nextSeq: number;
}

const initialState: QueueState = {
  ops: {},
  bindings: {},
  nextSeq: 0,
};

const queueSlice = createSlice({
  name: 'queue',
  initialState,
  reducers: {
    enqueue(state, action: PayloadAction<Omit<QueueOp, 'seq'>>) {
      const seq = state.nextSeq++;
      state.ops[action.payload.id] = { ...action.payload, seq };
    },
    // Patch arbitrary fields on an existing op (status flip, attempt bump,
    // nextAttemptAt schedule). The runner reaches for this rather than a
    // dozen specific reducers.
    patchOp(state, action: PayloadAction<{ id: string; patch: Partial<QueueOp> }>) {
      const op = state.ops[action.payload.id];
      if (!op) return;
      Object.assign(op, action.payload.patch);
    },
    removeOp(state, action: PayloadAction<string>) {
      delete state.ops[action.payload];
    },
    bindServerId(
      state,
      action: PayloadAction<{ collectionId: string; tempId: string; serverId: string }>,
    ) {
      const { collectionId, tempId, serverId } = action.payload;
      const id = `${collectionId}:${tempId}`;
      state.bindings[id] = {
        id,
        collectionId,
        tempId,
        serverId,
        boundAt: Date.now(),
      };
    },
    // Wipes everything — used by clearAll later, also handy in tests.
    reset(state) {
      state.ops = {};
      state.bindings = {};
      state.nextSeq = 0;
    },
    // Box #9: move an op into quarantine. The runner uses this for both
    // anchor (parent) ops that exhausted retries and for cascaded
    // dependents that share a correlation key.
    quarantineOp(
      state,
      action: PayloadAction<{
        id: string;
        reason: 'parent' | 'cascade';
        error?: string;
        at: number;
      }>,
    ) {
      const op = state.ops[action.payload.id];
      if (!op) return;
      op.status = 'quarantined';
      op.quarantineReason = action.payload.reason;
      op.quarantineError = action.payload.error;
      op.quarantinedAt = action.payload.at;
      // Clear scheduling so a recovery action that flips it back to
      // 'pending' fires immediately.
      op.nextAttemptAt = null;
    },
    // Box #10: requeue a quarantined op. Called by retryCascade /
    // discardAnchorRequeueRest.
    requeueOp(state, action: PayloadAction<string>) {
      const op = state.ops[action.payload];
      if (!op) return;
      op.status = 'pending';
      op.attempts = 0;
      op.nextAttemptAt = null;
      op.quarantineReason = undefined;
      op.quarantineError = undefined;
      op.quarantinedAt = undefined;
      // Bump seq so requeued ops don't compete with brand-new ones for
      // ordering; matches the TanStack DB version.
      op.seq = state.nextSeq++;
    },
  },
});

export const queueActions = queueSlice.actions;
export const queueReducer = queueSlice.reducer;
