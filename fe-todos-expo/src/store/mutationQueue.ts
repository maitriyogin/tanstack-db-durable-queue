import type { QueryClient } from '@tanstack/react-query';
import { state$ } from './state';
import type { QueueOp } from './types';

// Per-collection wiring — same shape as redux/valtio builds.
export type InsertHandlerResult = { serverId?: string } | void;

export interface CollectionHandlers<T = unknown> {
  onInsert?: (op: QueueOp<T>) => Promise<InsertHandlerResult>;
  onUpdate?: (op: QueueOp<T>) => Promise<void>;
  onDelete?: (op: QueueOp<T>) => Promise<void>;
  invalidates?: ReadonlyArray<readonly unknown[]>;
  primaryQueryKey: readonly unknown[];
  retrySafe?: RetrySafeMap | ((op: QueueOp<T>) => boolean);
  projections?: Record<string, ProjectionDef<T>>;
}

export interface RetrySafeMap {
  insert?: boolean;
  update?: boolean;
  delete?: boolean;
}

export interface ProjectionDef<T = unknown> {
  apply: (op: QueueOp<T>) => Promise<void>;
  optimistic?: (op: QueueOp<T>) => (() => void) | void;
  onError?: 'cascade' | 'tolerate' | 'quarantine';
}

export interface BackoffOptions {
  base?: number;
  cap?: number;
}

export interface MutationQueue {
  registerCollection<T>(collectionId: string, handlers: CollectionHandlers<T>): void;
  enqueueAndAwait<T>(op: Omit<QueueOp<T>, 'seq'>): Promise<void>;
  triggerDrain(): void;
  resolveServerId(collectionId: string, key: string): string;
  retryCascade(correlationKey: string): void;
  discardCascade(correlationKey: string): void;
  discardAnchorRequeueRest(correlationKey: string): void;
  ready(): Promise<void>;
  sessionId(): string;
}

export interface MutationQueueOptions {
  queryClient: QueryClient;
  isOnline?: () => boolean;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  backoff?: BackoffOptions;
}

const MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_SAFE: Required<RetrySafeMap> = {
  insert: false,
  update: true,
  delete: false,
};

// Same drain logic as fe-todos-redux's runner, expressed against the
// Legend State observable instead of the redux store. Reads use
// `state$.queue.ops.get()` (synchronous, returns a plain snapshot);
// writes use `state$.queue.ops[id].set(...)` (Legend State's mutation
// API). The persist plugin handles writing each change to localStorage.
//
// Why a hand-rolled runner here? Legend State's `synced()` / `syncedCrud()`
// own the dispatch loop and can persist + retry, but they don't:
//   1. Forward a stable per-op id as `X-Client-Op-Id` for BFF dedup.
//   2. Surface quarantined ops for a Retry/Discard UI.
//   3. Reconcile temp→server ids on insert ack.
// Adding all three on top of `synced` would be more code and harder to
// reason about than this runner.
export function createMutationQueue(opts: MutationQueueOptions): MutationQueue {
  const now = opts.now ?? (() => Date.now());
  const setTimer =
    opts.setTimeout ?? ((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms));
  const clearTimer =
    opts.clearTimeout ?? ((handle: unknown) => globalThis.clearTimeout(handle as any));
  const isOnline =
    opts.isOnline ??
    (() => {
      const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
      return nav?.onLine ?? true;
    });
  const BACKOFF_BASE = opts.backoff?.base ?? 500;
  const BACKOFF_CAP = opts.backoff?.cap ?? 30_000;

  const handlersByCollection = new Map<string, CollectionHandlers<any>>();
  const completions = new Map<
    string,
    { resolve: () => void; reject: (e: unknown) => void }
  >();
  const SESSION_ID = crypto.randomUUID();

  let draining = false;
  let drainRequestedDuringDrain = false;
  let wakeTimer: unknown = null;

  // ---- helpers reading the observable ----

  function getOps(): Record<string, QueueOp> {
    return state$.queue.ops.get() as Record<string, QueueOp>;
  }

  function getOp(id: string): QueueOp | undefined {
    const ops = getOps();
    return ops[id];
  }

  // Patch a subset of fields on an op. Legend State doesn't have a
  // built-in "merge into nested record" — the cleanest path is to read,
  // merge, write the whole row back. Cheap because each row is small.
  function patchOp(id: string, patch: Partial<QueueOp>) {
    const op = getOp(id);
    if (!op) return;
    state$.queue.ops[id]!.set({ ...op, ...patch } as QueueOp);
  }

  function settle(opId: string, result: { ok: true } | { ok: false; error: unknown }) {
    const d = completions.get(opId);
    if (!d) return;
    completions.delete(opId);
    if (result.ok) d.resolve();
    else d.reject(result.error);
  }

  // ---- pickNext + scheduling ----

  function pickNext(currentTime: number): QueueOp | undefined {
    let best: QueueOp | undefined;
    for (const op of Object.values(getOps())) {
      if (op.status !== 'pending') continue;
      if (op.nextAttemptAt != null && op.nextAttemptAt > currentTime) continue;
      if (!best || op.seq < best.seq) best = op;
    }
    return best;
  }

  function earliestScheduled(currentTime: number): number | null {
    let earliest: number | null = null;
    for (const op of Object.values(getOps())) {
      if (op.status !== 'pending') continue;
      if (op.nextAttemptAt == null || op.nextAttemptAt <= currentTime) continue;
      if (earliest == null || op.nextAttemptAt < earliest) earliest = op.nextAttemptAt;
    }
    return earliest;
  }

  function scheduleWake(currentTime: number) {
    if (wakeTimer != null) {
      clearTimer(wakeTimer);
      wakeTimer = null;
    }
    const earliest = earliestScheduled(currentTime);
    if (earliest == null) return;
    const delay = Math.max(0, earliest - currentTime);
    wakeTimer = setTimer(() => {
      wakeTimer = null;
      void drain();
    }, delay);
  }

  function backoffFor(attempts: number): number {
    return Math.min(BACKOFF_BASE * Math.pow(2, attempts - 1), BACKOFF_CAP);
  }

  // ---- bindings + key rewrite ----

  function resolveServerIdInternal(collectionId: string, key: string): string {
    const bindings = state$.queue.bindings.get() as Record<string, { collectionId: string; tempId: string; serverId: string }>;
    const entry = bindings[`${collectionId}:${key}`];
    return entry ? entry.serverId : key;
  }

  function rewriteForDispatch<T>(op: QueueOp<T>): QueueOp<T> {
    if (op.type === 'insert') return op;
    const serverId = resolveServerIdInternal(op.collectionId, op.key);
    return serverId === op.key ? op : { ...op, key: serverId };
  }

  // ---- retry policy ----

  function isRetrySafe<T>(op: QueueOp<T>): boolean {
    const handlers = handlersByCollection.get(op.collectionId);
    const policy = handlers?.retrySafe;
    if (typeof policy === 'function') return policy(op);
    if (policy && typeof policy === 'object') {
      return policy[op.type] ?? DEFAULT_RETRY_SAFE[op.type];
    }
    return DEFAULT_RETRY_SAFE[op.type];
  }

  // ---- run + drain ----

  async function runOp(op: QueueOp): Promise<void> {
    const handlers = handlersByCollection.get(op.collectionId);
    if (!handlers) {
      throw new Error(`No handlers registered for collection "${op.collectionId}"`);
    }
    const dispatchOp = rewriteForDispatch(op);
    if (op.type === 'insert') {
      const handler = handlers.onInsert;
      if (!handler) throw new Error(`No insert handler for "${op.collectionId}"`);
      const result = await handler(dispatchOp);
      const serverId = result?.serverId;
      if (serverId && serverId !== op.key) {
        const id = `${op.collectionId}:${op.key}`;
        state$.queue.bindings[id]!.set({
          id,
          collectionId: op.collectionId,
          tempId: op.key,
          serverId,
          boundAt: Date.now(),
        });
      }
      return;
    }
    const handler = op.type === 'update' ? handlers.onUpdate : handlers.onDelete;
    if (!handler) throw new Error(`No ${op.type} handler for "${op.collectionId}"`);
    await handler(dispatchOp);
  }

  async function runProjections(op: QueueOp) {
    const handlers = handlersByCollection.get(op.collectionId);
    const projections = handlers?.projections;
    if (!projections) return;
    const rollbacks: Array<() => void> = [];
    for (const [name, projection] of Object.entries(projections)) {
      const rollback = projection.optimistic?.(op) ?? (() => {});
      try {
        await projection.apply(op);
        rollbacks.push(rollback);
      } catch (err) {
        const policy = projection.onError ?? 'tolerate';
        if (policy === 'cascade') {
          try { rollback(); } catch { /* ignore */ }
          while (rollbacks.length) {
            try { rollbacks.pop()!(); } catch { /* ignore */ }
          }
          throw new Error(
            `Projection "${name}" cascaded failure: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        console.warn(
          `[durableQueue] projection "${name}" failed (${policy}):`,
          err,
        );
        try { rollback(); } catch { /* ignore */ }
      }
    }
  }

  async function invalidateAfterAck(op: QueueOp) {
    const handlers = handlersByCollection.get(op.collectionId);
    if (!handlers) return;
    const keys = [handlers.primaryQueryKey, ...(handlers.invalidates ?? [])];
    await Promise.all(
      keys.map((queryKey) => opts.queryClient.invalidateQueries({ queryKey })),
    );
  }

  function quarantineCascade(parent: QueueOp, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const stamp = now();
    patchOp(parent.id, {
      status: 'quarantined',
      quarantineReason: 'parent',
      quarantineError: message,
      quarantinedAt: stamp,
      nextAttemptAt: null,
    });
    if (parent.type !== 'insert') return;
    for (const op of Object.values(getOps())) {
      if (op.id === parent.id) continue;
      if (op.correlationKey !== parent.correlationKey) continue;
      if (op.status === 'quarantined') continue;
      patchOp(op.id, {
        status: 'quarantined',
        quarantineReason: 'cascade',
        quarantinedAt: stamp,
        nextAttemptAt: null,
      });
    }
  }

  async function drain(): Promise<void> {
    if (draining) {
      drainRequestedDuringDrain = true;
      return;
    }
    draining = true;
    drainRequestedDuringDrain = false;
    try {
      while (true) {
        if (!isOnline()) return;
        const t = now();
        const head = pickNext(t);
        if (!head) {
          scheduleWake(t);
          return;
        }
        patchOp(head.id, {
          status: 'inflight',
          attempts: head.attempts + 1,
          nextAttemptAt: null,
          sessionId: SESSION_ID,
          recoveredFromCrash: false,
        });
        // Re-read so we have the freshly-patched op for the dispatch.
        const inflight = getOp(head.id);
        if (!inflight) continue;

        try {
          await runOp(inflight);
          await runProjections(inflight);
          state$.queue.ops[inflight.id]!.delete();
          settle(inflight.id, { ok: true });
          await invalidateAfterAck(inflight);
        } catch (error) {
          const attemptsSoFar = inflight.attempts;
          const reachedCap = attemptsSoFar >= MAX_ATTEMPTS;
          const retryable = isRetrySafe(inflight);
          if (retryable && !reachedCap) {
            const delay = backoffFor(attemptsSoFar);
            patchOp(inflight.id, {
              status: 'pending',
              nextAttemptAt: now() + delay,
            });
            if (delay > 0) {
              scheduleWake(now());
              return;
            }
          } else {
            quarantineCascade(inflight, error);
          }
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

  // ---- box #10 recovery actions ----

  function quarantinedByCorrelation(correlationKey: string): QueueOp[] {
    return Object.values(getOps()).filter(
      (op) =>
        op.status === 'quarantined' && op.correlationKey === correlationKey,
    );
  }

  function requeue(op: QueueOp) {
    const seq = (state$.queue.nextSeq.get() as number) + 0;
    state$.queue.nextSeq.set(seq + 1);
    patchOp(op.id, {
      status: 'pending',
      attempts: 0,
      nextAttemptAt: null,
      quarantineReason: undefined,
      quarantineError: undefined,
      quarantinedAt: undefined,
      seq: seq,
    });
  }

  function retryCascadeImpl(correlationKey: string) {
    const group = quarantinedByCorrelation(correlationKey).sort(
      (a, b) => a.seq - b.seq,
    );
    for (const op of group) requeue(op);
    void drain();
  }

  function discardCascadeImpl(correlationKey: string) {
    const group = quarantinedByCorrelation(correlationKey);
    for (const op of group) {
      settle(op.id, {
        ok: false,
        error: new Error(
          op.quarantineReason === 'parent'
            ? `Discarded after quarantine: ${op.quarantineError ?? 'failed'}`
            : 'Discarded as part of cascade from quarantined op',
        ),
      });
      state$.queue.ops[op.id]!.delete();
    }
  }

  function discardAnchorRequeueRestImpl(correlationKey: string) {
    const group = quarantinedByCorrelation(correlationKey);
    if (group.length === 0) return;
    const anchor = group.find((op) => op.quarantineReason === 'parent');
    if (!anchor) {
      for (const op of group) requeue(op);
      void drain();
      return;
    }
    settle(anchor.id, {
      ok: false,
      error: new Error(
        `Discarded anchor after quarantine: ${anchor.quarantineError ?? 'failed'}`,
      ),
    });
    state$.queue.ops[anchor.id]!.delete();
    for (const op of group) {
      if (op.id === anchor.id) continue;
      requeue(op);
    }
    void drain();
  }

  // ---- box #12 cold-boot sweep ----

  function coldBootSweep() {
    const ops = getOps();
    const stamp = now();
    for (const op of Object.values(ops)) {
      if (op.status === 'quarantined') continue;
      const isStaleInflight =
        op.status === 'inflight' && op.sessionId !== SESSION_ID;
      const reachedCap = op.attempts >= MAX_ATTEMPTS;

      if (reachedCap) {
        if (op.status !== 'pending') {
          patchOp(op.id, {
            status: 'pending',
            recoveredFromCrash: isStaleInflight,
          });
        }
        quarantineCascade(
          { ...op, status: 'pending' },
          new Error('Recovered after crash and exceeded retry cap'),
        );
        continue;
      }

      if (isStaleInflight) {
        patchOp(op.id, {
          status: 'pending',
          recoveredFromCrash: true,
        });
      }
    }
    void drain();
    void stamp;
  }

  return {
    registerCollection<T>(collectionId: string, handlers: CollectionHandlers<T>) {
      handlersByCollection.set(collectionId, handlers);
    },
    enqueueAndAwait<T>(op: Omit<QueueOp<T>, 'seq'>) {
      return new Promise<void>((resolve, reject) => {
        completions.set(op.id, { resolve, reject });
        const seq = state$.queue.nextSeq.get() as number;
        state$.queue.nextSeq.set(seq + 1);
        state$.queue.ops[op.id]!.set({ ...op, seq } as QueueOp);
        void drain();
      });
    },
    triggerDrain() {
      const t = now();
      for (const op of Object.values(getOps())) {
        if (
          op.status === 'pending' &&
          op.nextAttemptAt != null &&
          op.nextAttemptAt > t
        ) {
          patchOp(op.id, { nextAttemptAt: null });
        }
      }
      void drain();
    },
    resolveServerId: resolveServerIdInternal,
    retryCascade: retryCascadeImpl,
    discardCascade: discardCascadeImpl,
    discardAnchorRequeueRest: discardAnchorRequeueRestImpl,
    async ready() {
      // syncObservable is synchronous on localStorage, so by module-load
      // time the persisted state is already in the observable. The sweep
      // can run immediately.
      coldBootSweep();
    },
    sessionId: () => SESSION_ID,
  };
}

export const TEMP_ID_PREFIX = 'temp_';
export function mintTempId(): string {
  return `${TEMP_ID_PREFIX}${crypto.randomUUID()}`;
}
