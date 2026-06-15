import { createListenerMiddleware, type ThunkAction, type AnyAction } from '@reduxjs/toolkit';
import { REHYDRATE } from 'redux-persist';
import { queueActions } from './queueSlice';
import { quarantineActions } from './quarantineSlice';
import { selectAllQueueOps } from './selectors';
import type { QuarantineRow } from './types';
import { MAX_ATTEMPTS } from './types';

export const bootstrapListener = createListenerMiddleware();

// The runner imports this and calls it on startup. The listener middleware
// also kicks it off on REHYDRATE so a quiet Provider mount still ends up
// running the sweep (e.g. tests that don't import the runner).
export const coldBootSweep =
  (sessionId: string): ThunkAction<Promise<void>, any, unknown, AnyAction> =>
  async (dispatch, getState) => {
    dispatch(queueActions.setSessionId(sessionId));

    const ops = selectAllQueueOps(getState());
    const now = Date.now();
    const cascadeRows: QuarantineRow[] = [];
    const cascadeIds: string[] = [];

    for (const op of ops) {
      // (a) Stale inflight from a previous (crashed) session.
      if (op.status === 'inflight' && op.sessionId !== sessionId) {
        dispatch(queueActions.markRecoveredFromCrash(op.id));
        continue;
      }
      // (b) Recovered op already exceeds the retry cap: quarantine.
      if (op.attempts >= MAX_ATTEMPTS) {
        cascadeRows.push({
          ...op,
          quarantineReason: 'parent',
          quarantineError: 'Recovered after crash and exceeded retry cap',
          quarantinedAt: now,
        });
        cascadeIds.push(op.id);
      }
      // (c) Pending with future nextAttemptAt — leave alone; runner will
      //     scheduleWake on first drain.
    }

    if (cascadeRows.length > 0) {
      dispatch(quarantineActions.quarantineMany(cascadeRows));
      for (const id of cascadeIds) dispatch(queueActions.removeOp(id));
    }

    dispatch(queueActions.setSweepComplete(true));
  };

bootstrapListener.startListening({
  predicate: (action) =>
    action.type === REHYDRATE && (action as { key?: string }).key === 'mutation-queue-v1',
  effect: async (_, api) => {
    const sessionId = crypto.randomUUID();
    await api.dispatch(coldBootSweep(sessionId) as any);
  },
});