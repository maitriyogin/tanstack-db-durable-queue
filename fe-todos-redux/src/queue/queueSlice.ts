import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { QueueOpRow } from './types';

export interface QueueState {
  ops: Record<string, QueueOpRow>;
  nextSeq: number;
  // sessionId is regenerated each cold boot; stripped from persisted payload
  // by the redux-persist transform.
  sessionId: string;
  // Flipped true after coldBootSweep completes. Runner gates first drain on this.
  sweepComplete: boolean;
}

const initialState: QueueState = {
  ops: {},
  nextSeq: 0,
  sessionId: '',
  sweepComplete: false,
};

const slice = createSlice({
  name: 'queue',
  initialState,
  reducers: {
    setSessionId(state, action: PayloadAction<string>) {
      state.sessionId = action.payload;
    },
    setSweepComplete(state, action: PayloadAction<boolean>) {
      state.sweepComplete = action.payload;
    },
    enqueueOp(state, action: PayloadAction<Omit<QueueOpRow, 'seq'>>) {
      const seq = state.nextSeq++;
      const op: QueueOpRow = { ...action.payload, seq };
      state.ops[op.id] = op;
    },
    insertOp(state, action: PayloadAction<QueueOpRow>) {
      // Used by recovery thunks that already have a seq (re-enqueue).
      state.ops[action.payload.id] = action.payload;
      if (action.payload.seq >= state.nextSeq) state.nextSeq = action.payload.seq + 1;
    },
    markInflight(
      state,
      action: PayloadAction<{ opId: string; sessionId: string }>,
    ) {
      const op = state.ops[action.payload.opId];
      if (!op) return;
      op.status = 'inflight';
      op.attempts += 1;
      op.sessionId = action.payload.sessionId;
      // recoveredFromCrash sticks until the next *attempt*; clear on flip.
      op.recoveredFromCrash = false;
    },
    markRecoveredFromCrash(state, action: PayloadAction<string>) {
      const op = state.ops[action.payload];
      if (!op) return;
      op.status = 'pending';
      op.recoveredFromCrash = true;
      op.sessionId = undefined;
    },
    scheduleRetry(
      state,
      action: PayloadAction<{ opId: string; nextAttemptAt: number | null }>,
    ) {
      const op = state.ops[action.payload.opId];
      if (!op) return;
      op.status = 'pending';
      op.nextAttemptAt = action.payload.nextAttemptAt;
    },
    clearBackoffs(state) {
      for (const id in state.ops) {
        const op = state.ops[id];
        if (op && op.status === 'pending' && op.nextAttemptAt != null) {
          op.nextAttemptAt = null;
        }
      }
    },
    removeOp(state, action: PayloadAction<string>) {
      delete state.ops[action.payload];
    },
    bumpSeq(state, action: PayloadAction<string>) {
      const op = state.ops[action.payload];
      if (!op) return;
      op.seq = state.nextSeq++;
    },
    clearAll(state) {
      state.ops = {};
      // Don't reset nextSeq — keep it monotonic across clears for safety.
    },
  },
});

export const queueActions = slice.actions;
export const queueReducer = slice.reducer;
export type { QueueOpRow };