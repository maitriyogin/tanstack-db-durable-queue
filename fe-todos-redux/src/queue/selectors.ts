import { createSelector } from '@reduxjs/toolkit';
import type { QueueState } from './queueSlice';
import type { QuarantineState } from './quarantineSlice';
import type { IdBindingsState } from './idBindingsSlice';
import type { QueueOpRow, QuarantineRow } from './types';
import { bindingKey } from './types';

// Selectors operate on the persisted queue subtree, mounted at `queueRoot`
// (see store.ts). Components call `useSelector` with the full RootState;
// we accept a structural type so test stores can mount it elsewhere.
interface RootSlices {
  queueRoot: {
    queue: QueueState;
    quarantine: QuarantineState;
    idBindings: IdBindingsState;
  };
}

const selectQueueState = (s: RootSlices) => s.queueRoot.queue;
const selectQuarantineState = (s: RootSlices) => s.queueRoot.quarantine;
const selectBindingsState = (s: RootSlices) => s.queueRoot.idBindings;

export const selectAllQueueOps = createSelector(
  [selectQueueState],
  (q): QueueOpRow[] => Object.values(q.ops),
);

export const selectActiveOps = createSelector([selectAllQueueOps], (ops) =>
  ops.filter((o) => o.status === 'pending'),
);

export const selectSweepComplete = (s: RootSlices): boolean =>
  s.queueRoot.queue.sweepComplete;

export const selectSessionId = (s: RootSlices): string => s.queueRoot.queue.sessionId;

// Cheap iteration; queue depth is typically <50, profile only if it isn't.
export function selectNextEligibleOp(
  s: RootSlices,
  now: number,
): QueueOpRow | undefined {
  let best: QueueOpRow | undefined;
  for (const id in s.queueRoot.queue.ops) {
    const op = s.queueRoot.queue.ops[id];
    if (!op || op.status !== 'pending') continue;
    if (op.nextAttemptAt != null && op.nextAttemptAt > now) continue;
    if (!best || op.seq < best.seq) best = op;
  }
  return best;
}

export function selectEarliestScheduledTime(
  s: RootSlices,
  now: number,
): number | null {
  let earliest: number | null = null;
  for (const id in s.queueRoot.queue.ops) {
    const op = s.queueRoot.queue.ops[id];
    if (!op || op.status !== 'pending') continue;
    if (op.nextAttemptAt == null) return now; // already due
    if (earliest == null || op.nextAttemptAt < earliest) {
      earliest = op.nextAttemptAt;
    }
  }
  return earliest;
}

export function selectOpsByCorrelationKey(
  s: RootSlices,
  key: string,
): QueueOpRow[] {
  const out: QueueOpRow[] = [];
  for (const id in s.queueRoot.queue.ops) {
    const op = s.queueRoot.queue.ops[id];
    if (op && op.correlationKey === key) out.push(op);
  }
  return out;
}

export function selectQuarantineByCorrelationKey(
  s: RootSlices,
  key: string,
): QuarantineRow[] {
  const out: QuarantineRow[] = [];
  for (const id in s.queueRoot.quarantine.ops) {
    const op = s.queueRoot.quarantine.ops[id];
    if (op && op.correlationKey === key) out.push(op);
  }
  return out;
}

export const selectAllQuarantine = createSelector(
  [selectQuarantineState],
  (q): QuarantineRow[] => Object.values(q.ops),
);

export function selectQuarantineForCollection(
  s: RootSlices,
  collectionId: string,
): QuarantineRow[] {
  const out: QuarantineRow[] = [];
  for (const id in s.queueRoot.quarantine.ops) {
    const op = s.queueRoot.quarantine.ops[id];
    if (op && op.collectionId === collectionId) out.push(op);
  }
  return out;
}

export function selectServerIdFor(
  s: RootSlices,
  collectionId: string,
  key: string,
): string {
  const k = bindingKey(collectionId, key);
  return s.queueRoot.idBindings.byKey[k]?.serverId ?? key;
}

// server→temp lookup so React keys stay stable across the temp→server flip.
export function selectAliasFor(
  s: RootSlices,
  collectionId: string,
  key: string,
): string {
  for (const k in s.queueRoot.idBindings.byKey) {
    const b = s.queueRoot.idBindings.byKey[k];
    if (b && b.collectionId === collectionId && b.serverId === key) {
      return b.tempId;
    }
  }
  return key;
}

export const selectQueueSize = createSelector(
  [selectAllQueueOps],
  (ops) => ops.length,
);