import type { Store } from '@reduxjs/toolkit';
import { queueActions } from './queueSlice';
import { idBindingsActions } from './idBindingsSlice';
import { quarantineActions } from './quarantineSlice';
import {
  selectNextEligibleOp,
  selectEarliestScheduledTime,
  selectOpsByCorrelationKey,
  selectQuarantineByCorrelationKey,
  selectServerIdFor,
  selectAliasFor,
  selectSweepComplete,
  selectAllQueueOps,
} from './selectors';
import {
  getHandle,
  resolveHandle,
  rejectHandle,
  clearHandle,
  undoAndClearHandle,
  markHandleQuarantined,
  clearAllHandles,
} from './handles';
import type { QueueOpRow, QuarantineRow } from './types';
import { MAX_ATTEMPTS, bindingKey } from './types';

export interface RunnerLogEvent {
  stage: string;
  [k: string]: unknown;
}

export type RunnerLogger = (ev: RunnerLogEvent) => void;

export interface CollectionRuntime {
  // Performs the server-side work for `op`. Returns `{ serverId }` on insert
  // when the response carries a real id; runner uses it to drive the bind.
  dispatch: (op: QueueOpRow) => Promise<{ serverId?: string } | void>;
  // Default: only updates retry. Override per collection or per op.
  isRetrySafe?: (op: QueueOpRow) => boolean;
  // After ack, runner dispatches `api.util.invalidateTags(...)` with this.
  invalidates?: (op: QueueOpRow) => unknown;
  // Optional projections (e.g. recordAudit, decrementBudget). Runner runs
  // them in declared order after parent ack.
  projections?: Record<string, Projection>;
  // After the optimistic patches were applied at enqueue time, the runner
  // doesn't know the recipe. On cold-boot it asks the collection to re-derive
  // the recipe from the persisted op so the optimistic UI re-appears.
  rehydrateOptimistic?: (op: QueueOpRow) => void;
  // Custom correlation-key resolver. Default is `${collectionId}:${serverIdOrKey}`.
  correlationKey?: (op: QueueOpRow) => string;
}

export interface Projection {
  optimistic?: (op: QueueOpRow) => () => void;
  apply: (op: QueueOpRow) => Promise<void>;
  onError?: 'cascade' | 'tolerate' | 'quarantine';
}

export interface RunnerOptions {
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  isOnline?: () => boolean;
  backoff?: { base: number; cap: number };
  logger?: RunnerLogger;
  invalidateTags?: (tags: unknown) => void;
}

export interface MutationRunner {
  registerCollection(id: string, rt: CollectionRuntime): void;
  attachStore(store: Store): void;
  setInvalidateTags(fn: (tags: unknown) => void): void;
  start(): Promise<void>;
  triggerDrain(): void;
  drain(): Promise<void>;
  bindServerId(collectionId: string, tempId: string, serverId: string): void;
  resolveServerId(collectionId: string, key: string): string;
  aliasFor(collectionId: string, key: string): string;
  rewriteKeyForDispatch(op: QueueOpRow): QueueOpRow;
  retryCascade(correlationKey: string): void;
  discardCascade(correlationKey: string): void;
  discardAnchorRequeueRest(correlationKey: string): void;
  clearLocalState(): void;
  sessionId(): string;
  subscribeBindings(
    listener: (b: { collectionId: string; tempId: string; serverId: string }) => void,
  ): () => void;
  subscribeQuarantine(listener: () => void): () => void;
}

export function createMutationRunner(options: RunnerOptions = {}): MutationRunner {
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearTimer = options.clearTimeout ?? ((h) => globalThis.clearTimeout(h as number));
  const isOnline =
    options.isOnline ??
    (() => (typeof navigator !== 'undefined' ? navigator.onLine : true));
  const BACKOFF_BASE = options.backoff?.base ?? 500;
  const BACKOFF_CAP = options.backoff?.cap ?? 30_000;
  const logger: RunnerLogger = options.logger ?? (() => {});
  let invalidateTags: (tags: unknown) => void = options.invalidateTags ?? (() => {});

  let store: Store | null = null;
  const SESSION_ID = crypto.randomUUID();
  const handlersByCollection = new Map<string, CollectionRuntime>();
  let draining = false;
  let drainRequestedDuringDrain = false;
  let wakeTimer: unknown = null;
  let lastQuarantineRevision = 0;

  const bindingListeners = new Set<
    (b: { collectionId: string; tempId: string; serverId: string }) => void
  >();
  const quarantineListeners = new Set<() => void>();

  function getStore(): Store {
    if (!store) throw new Error('Runner has no store; call attachStore() first.');
    return store;
  }

  function log(stage: string, extra: Record<string, unknown> = {}): void {
    logger({ stage, ...extra });
  }

  function notifyQuarantine(): void {
    lastQuarantineRevision++;
    for (const fn of quarantineListeners) {
      try {
        fn();
      } catch (e) {
        console.warn('[durableQueue] quarantine listener threw:', e);
      }
    }
  }

  function notifyBinding(b: {
    collectionId: string;
    tempId: string;
    serverId: string;
  }): void {
    for (const fn of bindingListeners) {
      try {
        fn(b);
      } catch (e) {
        console.warn('[durableQueue] binding listener threw:', e);
      }
    }
  }

  function defaultIsRetrySafe(op: QueueOpRow): boolean {
    return op.type === 'update';
  }

  function backoffMsForAttempt(n: number): number {
    return Math.min(BACKOFF_BASE * Math.pow(2, n - 1), BACKOFF_CAP);
  }

  function scheduleWake(currentTime: number): void {
    if (wakeTimer != null) {
      clearTimer(wakeTimer);
      wakeTimer = null;
    }
    const earliest = selectEarliestScheduledTime(getStore().getState() as any, currentTime);
    if (earliest == null) return;
    const delay = Math.max(0, earliest - currentTime);
    wakeTimer = setTimer(() => {
      wakeTimer = null;
      void drain();
    }, delay);
  }

  // ---- Public ----

  function registerCollection(id: string, rt: CollectionRuntime): void {
    handlersByCollection.set(id, rt);
  }

  function attachStore(s: Store): void {
    store = s;
    // Stamp our session id once on the slice for diagnostics + cold-boot.
    s.dispatch(queueActions.setSessionId(SESSION_ID));
  }

  function setInvalidateTags(fn: (tags: unknown) => void): void {
    invalidateTags = fn;
  }

  async function start(): Promise<void> {
    // Wait for the listener middleware (or a manual coldBootSweep dispatch)
    // to flip sweepComplete. PersistGate gates the React tree; this gate
    // protects the runner from racing rehydrate.
    await waitFor(() => selectSweepComplete(getStore().getState() as any));

    // Re-apply optimistic patches for any persisted active op so the UI
    // looks the same as before the reload.
    const ops = selectAllQueueOps(getStore().getState() as any);
    for (const op of ops) {
      const rt = handlersByCollection.get(op.collectionId);
      try {
        rt?.rehydrateOptimistic?.(op);
      } catch (e) {
        console.warn('[durableQueue] rehydrateOptimistic threw:', e);
      }
    }

    void drain();
  }

  async function waitFor(pred: () => boolean): Promise<void> {
    if (pred()) return;
    return new Promise((resolve) => {
      const unsub = getStore().subscribe(() => {
        if (pred()) {
          unsub();
          resolve();
        }
      });
    });
  }

  function triggerDrain(): void {
    if (!store) return;
    getStore().dispatch(queueActions.clearBackoffs());
    void drain();
  }

  // The core mutex-coalesced runner.
  async function drain(): Promise<void> {
    if (!store) return;
    if (draining) {
      drainRequestedDuringDrain = true;
      return;
    }
    if (!selectSweepComplete(getStore().getState() as any)) return;
    draining = true;
    drainRequestedDuringDrain = false;
    try {
      while (true) {
        if (!isOnline()) {
          log('offline-paused');
          return;
        }
        const t = now();
        const head = selectNextEligibleOp(getStore().getState() as any, t);
        if (!head) {
          scheduleWake(t);
          return;
        }

        getStore().dispatch(
          queueActions.markInflight({ opId: head.id, sessionId: SESSION_ID }),
        );

        const dispatchOp = rewriteKeyForDispatch(head);
        const rt = handlersByCollection.get(head.collectionId);
        if (!rt) {
          console.warn(`[durableQueue] no runtime for ${head.collectionId}; dropping op`);
          getStore().dispatch(queueActions.removeOp(head.id));
          rejectHandle(head.id, new Error(`no runtime for ${head.collectionId}`));
          clearHandle(head.id);
          continue;
        }

        const isRetrySafe = rt.isRetrySafe ?? defaultIsRetrySafe;
        const correlationKey = head.correlationKey;
        log('inflight', {
          opId: head.id,
          collectionId: head.collectionId,
          type: head.type,
          key: head.key,
          attempt: head.attempts + 1,
          payload: head.payload,
          correlationKey,
        });

        try {
          const result = await rt.dispatch(dispatchOp);

          // Insert ack: bind temp→server.
          if (
            head.type === 'insert' &&
            result &&
            'serverId' in result &&
            result.serverId &&
            result.serverId !== head.key
          ) {
            bindServerId(head.collectionId, head.key, result.serverId);
          }

          await runProjections(head, rt);

          const tags = rt.invalidates?.(head);
          if (tags) {
            try {
              invalidateTags(tags);
            } catch (e) {
              console.warn('[durableQueue] invalidateTags threw:', e);
            }
          }

          getStore().dispatch(queueActions.removeOp(head.id));
          resolveHandle(head.id);
          clearHandle(head.id);
          log('ack', { opId: head.id });
        } catch (err) {
          const retryable = isRetrySafe(head);
          const attempts = head.attempts; // already incremented by markInflight
          const message = err instanceof Error ? err.message : String(err);
          log('reject', { opId: head.id, error: message, retryable, attempts });

          if (retryable && attempts < MAX_ATTEMPTS) {
            const delay = backoffMsForAttempt(attempts);
            const nextAttemptAt = delay > 0 ? now() + delay : null;
            getStore().dispatch(
              queueActions.scheduleRetry({ opId: head.id, nextAttemptAt }),
            );
            log('retry-scheduled', { opId: head.id, delayMs: delay });
            if (delay > 0) {
              scheduleWake(now());
              return;
            }
            continue;
          }

          await quarantineCascade(head, err);
        }
      }
    } finally {
      draining = false;
      if (drainRequestedDuringDrain) {
        drainRequestedDuringDrain = false;
        void drain();
      }
    }
  }

  async function runProjections(
    op: QueueOpRow,
    rt: CollectionRuntime,
  ): Promise<void> {
    if (!rt.projections) return;
    const rollbacks: Array<() => void> = [];
    const names = Object.keys(rt.projections);
    for (const name of names) {
      const projection = rt.projections[name];
      if (!projection) continue;
      const policy = projection.onError ?? 'tolerate';
      let rollback: (() => void) | undefined;
      try {
        rollback = projection.optimistic?.(op);
        if (rollback) rollbacks.push(rollback);
        await projection.apply(op);
      } catch (e) {
        console.warn(`[durableQueue] projection "${name}" failed:`, e);
        if (rollback) {
          try {
            rollback();
          } catch {
            // ignore
          }
        }
        if (policy === 'cascade') {
          // Roll back earlier projections in reverse order, rethrow.
          for (let i = rollbacks.length - 2; i >= 0; i--) {
            try {
              rollbacks[i]?.();
            } catch {
              // ignore
            }
          }
          throw e;
        }
        // tolerate / quarantine: keep going, parent stays acked.
      }
    }
  }

  async function quarantineCascade(parent: QueueOpRow, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const stamp = now();

    const cascade =
      parent.type === 'insert'
        ? selectOpsByCorrelationKey(getStore().getState() as any, parent.correlationKey)
            .filter((row) => row.id !== parent.id)
        : [];

    const parentRow: QuarantineRow = {
      ...parent,
      status: 'pending',
      nextAttemptAt: null,
      quarantineReason: 'parent',
      quarantineError: message,
      quarantinedAt: stamp,
    };
    getStore().dispatch(quarantineActions.quarantineOp(parentRow));
    getStore().dispatch(queueActions.removeOp(parent.id));
    markHandleQuarantined(parent.id, true);
    log('quarantine', {
      opId: parent.id,
      collectionId: parent.collectionId,
      type: parent.type,
      key: parent.key,
      attempts: parent.attempts,
      error: message,
      cascadeSize: cascade.length,
      correlationKey: parent.correlationKey,
    });

    for (const sibling of cascade) {
      const cascadeRow: QuarantineRow = {
        ...sibling,
        status: 'pending',
        nextAttemptAt: null,
        quarantineReason: 'cascade',
        quarantinedAt: stamp,
      };
      getStore().dispatch(quarantineActions.quarantineOp(cascadeRow));
      getStore().dispatch(queueActions.removeOp(sibling.id));
      markHandleQuarantined(sibling.id, true);
      log('cascade', {
        opId: sibling.id,
        anchorOpId: parent.id,
        correlationKey: parent.correlationKey,
      });
    }

    notifyQuarantine();
  }

  function bindServerId(collectionId: string, tempId: string, serverId: string): void {
    if (tempId === serverId) return;
    const boundAt = now();
    getStore().dispatch(idBindingsActions.add({ collectionId, tempId, serverId, boundAt }));
    log('bind', { collectionId, tempId, serverId });
    notifyBinding({ collectionId, tempId, serverId });
  }

  function resolveServerId(collectionId: string, key: string): string {
    return selectServerIdFor(getStore().getState() as any, collectionId, key);
  }

  function aliasFor(collectionId: string, key: string): string {
    return selectAliasFor(getStore().getState() as any, collectionId, key);
  }

  function rewriteKeyForDispatch(op: QueueOpRow): QueueOpRow {
    if (op.type === 'insert') return op;
    const serverId = resolveServerId(op.collectionId, op.key);
    if (serverId === op.key) return op;
    return { ...op, key: serverId };
  }

  function retryCascade(correlationKey: string): void {
    if (!store) return;
    const group = selectQuarantineByCorrelationKey(
      getStore().getState() as any,
      correlationKey,
    );
    if (group.length === 0) return;
    log('recovery-retry', { correlationKey, count: group.length });
    const ids = group.map((g) => g.id);
    group.sort((a, b) => a.seq - b.seq);
    for (const op of group) {
      const fresh: QueueOpRow = {
        ...op,
        attempts: 0,
        status: 'pending',
        nextAttemptAt: null,
      };
      // Strip quarantine fields by spreading into a fresh object.
      delete (fresh as Partial<QuarantineRow>).quarantineReason;
      delete (fresh as Partial<QuarantineRow>).quarantineError;
      delete (fresh as Partial<QuarantineRow>).quarantinedAt;
      getStore().dispatch(queueActions.insertOp(fresh));
      getStore().dispatch(queueActions.bumpSeq(fresh.id));
      markHandleQuarantined(op.id, false);
    }
    getStore().dispatch(quarantineActions.dropRows(ids));
    notifyQuarantine();
    void drain();
  }

  function discardCascade(correlationKey: string): void {
    if (!store) return;
    const group = selectQuarantineByCorrelationKey(
      getStore().getState() as any,
      correlationKey,
    );
    if (group.length === 0) return;
    log('recovery-discard', { correlationKey, count: group.length });
    for (const op of group) {
      const reason =
        op.quarantineReason === 'parent'
          ? `Discarded after quarantine: ${op.quarantineError ?? 'failed'}`
          : `Discarded as part of cascade from quarantined op`;
      undoAndClearHandle(op.id);
      rejectHandle(op.id, new Error(reason));
      // Fallthrough — handle is already cleared above; rejectHandle is a noop now.
    }
    getStore().dispatch(quarantineActions.dropRows(group.map((g) => g.id)));
    notifyQuarantine();
  }

  function discardAnchorRequeueRest(correlationKey: string): void {
    if (!store) return;
    const group = selectQuarantineByCorrelationKey(
      getStore().getState() as any,
      correlationKey,
    );
    if (group.length === 0) return;
    const anchor = group.find((op) => op.quarantineReason === 'parent');
    log('recovery-discard-anchor', {
      correlationKey,
      anchorOpId: anchor?.id,
      requeueCount: group.length - (anchor ? 1 : 0),
    });
    if (!anchor) {
      retryCascade(correlationKey);
      return;
    }
    undoAndClearHandle(anchor.id);
    rejectHandle(
      anchor.id,
      new Error(`Discarded anchor after quarantine: ${anchor.quarantineError ?? 'failed'}`),
    );
    getStore().dispatch(quarantineActions.dropRows([anchor.id]));
    for (const op of group) {
      if (op.id === anchor.id) continue;
      const fresh: QueueOpRow = {
        ...op,
        attempts: 0,
        status: 'pending',
        nextAttemptAt: null,
      };
      delete (fresh as Partial<QuarantineRow>).quarantineReason;
      delete (fresh as Partial<QuarantineRow>).quarantineError;
      delete (fresh as Partial<QuarantineRow>).quarantinedAt;
      getStore().dispatch(queueActions.insertOp(fresh));
      getStore().dispatch(queueActions.bumpSeq(fresh.id));
      markHandleQuarantined(op.id, false);
      getStore().dispatch(quarantineActions.dropRows([op.id]));
    }
    notifyQuarantine();
    void drain();
  }

  function clearLocalState(): void {
    if (!store) return;
    if (wakeTimer != null) {
      clearTimer(wakeTimer);
      wakeTimer = null;
    }
    clearAllHandles();
    getStore().dispatch(queueActions.clearAll());
    getStore().dispatch(quarantineActions.clearAll());
    getStore().dispatch(idBindingsActions.clearAll());
    draining = false;
    drainRequestedDuringDrain = false;
    notifyQuarantine();
  }

  function subscribeBindings(
    listener: (b: { collectionId: string; tempId: string; serverId: string }) => void,
  ): () => void {
    bindingListeners.add(listener);
    return () => bindingListeners.delete(listener);
  }

  function subscribeQuarantine(listener: () => void): () => void {
    quarantineListeners.add(listener);
    return () => quarantineListeners.delete(listener);
  }

  return {
    registerCollection,
    attachStore,
    setInvalidateTags,
    start,
    triggerDrain,
    drain,
    bindServerId,
    resolveServerId,
    aliasFor,
    rewriteKeyForDispatch,
    retryCascade,
    discardCascade,
    discardAnchorRequeueRest,
    clearLocalState,
    sessionId: () => SESSION_ID,
    subscribeBindings,
    subscribeQuarantine,
  };
}

// Module-singleton runner used by the rest of the app. Tests can construct
// their own via createMutationRunner with injected clocks.
export const runner: MutationRunner = createMutationRunner({
  logger: (ev) => {
    if (typeof window !== 'undefined' && (window as any).__DURABLE_QUEUE_LOG !== false) {
      // eslint-disable-next-line no-console
      console.log('[durableQueue]', ev.stage, ev);
    }
  },
});

export { bindingKey };