import type { QueryClient } from '@tanstack/react-query';
import { queueActions } from './queueSlice';
import type { AppDispatch, RootState } from './store';
import type { QueueOp } from './types';

// Per-collection wiring: how each op type is dispatched against the server,
// what queries to invalidate after an ack, what render alias the row uses.
// The TanStack DB version did this by composing collection options; here we
// just register handlers explicitly. Closer to the metal, more boilerplate.
export type InsertHandlerResult = { serverId?: string } | void;

export interface CollectionHandlers<T = unknown> {
  onInsert?: (op: QueueOp<T>) => Promise<InsertHandlerResult>;
  onUpdate?: (op: QueueOp<T>) => Promise<void>;
  onDelete?: (op: QueueOp<T>) => Promise<void>;
  // After a successful op, refetch these TQ queries. Same shape as the
  // TanStack DB `invalidates` option. The primary's own refetch is wired
  // separately in registerCollection so consumers don't have to remember it.
  invalidates?: ReadonlyArray<readonly unknown[]>;
  // The TQ query key for the primary read. Invalidated on every successful
  // op for this collection — that's box #3 (ack reconciliation + refetch).
  primaryQueryKey: readonly unknown[];
  // Box #7: which ops are safe to retry on failure. Defaults: only updates
  // are retryable. Inserts and deletes opt-in explicitly because repeating
  // them risks dup rows or "already deleted" errors without server-side
  // idempotency. (The BFF in this repo *does* support idempotency via
  // X-Client-Op-Id, so a caller can safely flip these to true if desired.)
  retrySafe?: RetrySafeMap | ((op: QueueOp<T>) => boolean);
  // Box #6: multi-collection projections. After the parent op acks, each
  // projection runs in declared order — its `apply` fires server-side
  // work, its optional `optimistic` returns a rollback thunk. `cascade`
  // failure rolls earlier projections back and rethrows so the parent
  // also rolls back; `tolerate` (default) logs and continues.
  projections?: Record<string, ProjectionDef<T>>;
}

// ProjectionDef shape mirrors fe-todos. Only `apply` is required.
export interface ProjectionDef<T = unknown> {
  apply: (op: QueueOp<T>) => Promise<void>;
  optimistic?: (op: QueueOp<T>) => (() => void) | void;
  onError?: 'cascade' | 'tolerate' | 'quarantine';
}

export interface RetrySafeMap {
  insert?: boolean;
  update?: boolean;
  delete?: boolean;
}

// Box #8 backoff curve options. Defaults match the TanStack DB version:
// 500ms base, 30s cap.
export interface BackoffOptions {
  base?: number;
  cap?: number;
}

export interface MutationQueue {
  registerCollection<T>(collectionId: string, handlers: CollectionHandlers<T>): void;
  // Caller-facing "I want to enqueue this op and wait until it lands or
  // terminally fails." Mirrors awaitOpCompletion in the TanStack DB version.
  enqueueAndAwait<T>(op: Omit<QueueOp<T>, 'seq'>): Promise<void>;
  // Prods the runner. Coalesces with concurrent calls behind the same
  // mutex the wake timer uses (box #11).
  triggerDrain(): void;
  // Temp→server id resolution. The runner uses this internally to rewrite
  // ops before dispatch; consumers may use it to keep handlers idempotent
  // when payloads include foreign-key references (e.g. shoppingListId on a
  // budget row in the larger fe-todos demo).
  resolveServerId(collectionId: string, key: string): string;
  // Box #10 recovery actions on a quarantined cascade.
  retryCascade(correlationKey: string): void;
  discardCascade(correlationKey: string): void;
  discardAnchorRequeueRest(correlationKey: string): void;
  // Box #12 sweep + this session's id. Called once after PersistGate has
  // rehydrated state; reconciles any inflight rows left by a crashed
  // session.
  ready(): Promise<void>;
  sessionId(): string;
}

export interface MutationQueueOptions {
  store: { getState: () => RootState; dispatch: AppDispatch };
  queryClient: QueryClient;
  // Connectivity gate. When false the runner pauses instead of attempting
  // ops — matches the TanStack DB version's offline-paused behavior.
  isOnline?: () => boolean;
  // Test-injectable clock + timer. Production uses globals.
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  backoff?: BackoffOptions;
}

// Soft cap on retries before the op moves to quarantine. Box #9 turns this
// into an actual quarantine instead of a plain reject.
const MAX_ATTEMPTS = 5;

export function createMutationQueue(opts: MutationQueueOptions): MutationQueue {
  const { store, queryClient } = opts;
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
  // One deferred per queued op, kept in-process. Box #9 changes this:
  // quarantined ops *intentionally* keep their deferred unsettled so the
  // optimistic state stays visible until the user picks a recovery action.
  const completions = new Map<
    string,
    { resolve: () => void; reject: (e: unknown) => void }
  >();

  // Box #12: stamped on every op that flips to inflight. Sweep uses it to
  // identify ops left dangling by a previous (crashed) session.
  const SESSION_ID = crypto.randomUUID();

  let draining = false;
  // Box #11: a trigger fired during drain shouldn't be lost. Set the flag,
  // re-run drain in the finally block.
  let drainRequestedDuringDrain = false;
  let wakeTimer: unknown = null;

  function settle(opId: string, result: { ok: true } | { ok: false; error: unknown }) {
    const d = completions.get(opId);
    if (!d) return;
    completions.delete(opId);
    if (result.ok) d.resolve();
    else d.reject(result.error);
  }

  // ---- pickNext + scheduling ----

  function pickNext(currentTime: number): QueueOp | undefined {
    const ops = store.getState().queue.ops;
    let best: QueueOp | undefined;
    for (const op of Object.values(ops) as QueueOp[]) {
      if (op.status !== 'pending') continue;
      if (op.nextAttemptAt != null && op.nextAttemptAt > currentTime) continue;
      if (!best || op.seq < best.seq) best = op;
    }
    return best;
  }

  // Box #8: among pending ops not yet eligible, the earliest scheduled time.
  function earliestScheduled(currentTime: number): number | null {
    const ops = store.getState().queue.ops;
    let earliest: number | null = null;
    for (const op of Object.values(ops) as QueueOp[]) {
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
    const bindings = store.getState().queue.bindings;
    const entry = bindings[`${collectionId}:${key}`];
    return entry ? entry.serverId : key;
  }

  function rewriteForDispatch<T>(op: QueueOp<T>): QueueOp<T> {
    if (op.type === 'insert') return op;
    const serverId = resolveServerIdInternal(op.collectionId, op.key);
    return serverId === op.key ? op : { ...op, key: serverId };
  }

  // ---- retry policy ----

  // Default per-op-type policy: only updates are retryable. Inserts/deletes
  // would risk duplication without server-side idempotency. The BFF in this
  // repo supports it via X-Client-Op-Id (the queue forwards op.id for that),
  // so callers can flip these on for individual collections if they want.
  const DEFAULT_RETRY_SAFE: Required<RetrySafeMap> = {
    insert: false,
    update: true,
    delete: false,
  };

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
        store.dispatch(
          queueActions.bindServerId({
            collectionId: op.collectionId,
            tempId: op.key,
            serverId,
          }),
        );
      }
      return;
    }
    const handler = op.type === 'update' ? handlers.onUpdate : handlers.onDelete;
    if (!handler) throw new Error(`No ${op.type} handler for "${op.collectionId}"`);
    await handler(dispatchOp);
  }

  async function invalidateAfterAck(op: QueueOp) {
    const handlers = handlersByCollection.get(op.collectionId);
    if (!handlers) return;
    const keys = [handlers.primaryQueryKey, ...(handlers.invalidates ?? [])];
    await Promise.all(
      keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    );
  }

  // Box #6: run declared projections in order, after the parent op's
  // server apply succeeded. Each `optimistic()` returns a rollback thunk
  // we hold onto in case a later `cascade` projection fails.
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
          // Roll this projection back, then any earlier ones in reverse.
          try {
            rollback();
          } catch {
            // ignore
          }
          while (rollbacks.length) {
            try {
              rollbacks.pop()!();
            } catch {
              // ignore
            }
          }
          throw new Error(
            `Projection "${name}" cascaded failure: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        // tolerate / quarantine: log + roll back this projection's
        // optimistic state, parent continues.
        console.warn(
          `[durableQueue] projection "${name}" failed (${policy}):`,
          err,
        );
        try {
          rollback();
        } catch {
          // ignore
        }
      }
    }
  }

  // Box #9: move parent + (only-if-insert) dependent siblings into
  // quarantine. Doesn't settle the deferred — the optimistic state stays
  // visible until a recovery action settles it (box #10).
  function quarantineCascade(parent: QueueOp, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const stamp = now();
    store.dispatch(
      queueActions.quarantineOp({
        id: parent.id,
        reason: 'parent',
        error: message,
        at: stamp,
      }),
    );
    if (parent.type !== 'insert') return;
    const ops = store.getState().queue.ops;
    for (const op of Object.values(ops) as QueueOp[]) {
      if (op.id === parent.id) continue;
      if (op.correlationKey !== parent.correlationKey) continue;
      // Already quarantined ops shouldn't be re-cascaded.
      if (op.status === 'quarantined') continue;
      store.dispatch(
        queueActions.quarantineOp({ id: op.id, reason: 'cascade', at: stamp }),
      );
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
          // Nothing eligible now; arm wake timer for the earliest backed-off
          // op, then exit. The timer fires drain() again at the right time.
          scheduleWake(t);
          return;
        }

        store.dispatch(
          queueActions.patchOp({
            id: head.id,
            patch: {
              status: 'inflight',
              attempts: head.attempts + 1,
              nextAttemptAt: null,
              sessionId: SESSION_ID,
              recoveredFromCrash: false,
            },
          }),
        );

        try {
          await runOp(head);
          // Box #6: run projections AFTER the parent succeeds. A cascade
          // failure throws, falling into the catch below, which routes
          // the parent into quarantine like any other terminal failure.
          await runProjections(head);
          store.dispatch(queueActions.removeOp(head.id));
          settle(head.id, { ok: true });
          await invalidateAfterAck(head);
        } catch (error) {
          const attemptsSoFar = head.attempts + 1;
          const reachedCap = attemptsSoFar >= MAX_ATTEMPTS;
          const retryable = isRetrySafe(head);
          if (retryable && !reachedCap) {
            // Box #8: schedule the next attempt.
            const delay = backoffFor(attemptsSoFar);
            const dueAt = now() + delay;
            store.dispatch(
              queueActions.patchOp({
                id: head.id,
                patch: { status: 'pending', nextAttemptAt: dueAt },
              }),
            );
            if (delay > 0) {
              scheduleWake(now());
              return;
            }
            // delay === 0 (configured backoff disabled): fall through and
            // let the next loop iteration pick this op up again.
          } else {
            // Box #9: terminal failure (or retry cap hit) → quarantine.
            // Don't settle the deferred — the optimistic state stays
            // visible. Recovery actions are what eventually settle it.
            quarantineCascade(head, error);
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
    return Object.values(store.getState().queue.ops).filter(
      (op) =>
        op.status === 'quarantined' && op.correlationKey === correlationKey,
    );
  }

  function retryCascadeImpl(correlationKey: string) {
    const group = quarantinedByCorrelation(correlationKey);
    // Anchor first so dependents drain after it lands.
    group.sort((a, b) => a.seq - b.seq);
    for (const op of group) {
      store.dispatch(queueActions.requeueOp(op.id));
    }
    void drain();
  }

  function discardCascadeImpl(correlationKey: string) {
    const group = quarantinedByCorrelation(correlationKey);
    for (const op of group) {
      // Settle the deferred with a discard error. Caller (the optimistic
      // mutation) sees its promise reject; the overlay then drops the row
      // because selectTodos no longer sees the op in the queue.
      settle(op.id, {
        ok: false,
        error: new Error(
          op.quarantineReason === 'parent'
            ? `Discarded after quarantine: ${op.quarantineError ?? 'failed'}`
            : 'Discarded as part of cascade from quarantined op',
        ),
      });
      store.dispatch(queueActions.removeOp(op.id));
    }
  }

  function discardAnchorRequeueRestImpl(correlationKey: string) {
    const group = quarantinedByCorrelation(correlationKey);
    if (group.length === 0) return;
    const anchor = group.find((op) => op.quarantineReason === 'parent');
    if (!anchor) {
      // No parent in this group — nothing to anchor-discard. Treat as a
      // plain retry of the dependents.
      for (const op of group) store.dispatch(queueActions.requeueOp(op.id));
      void drain();
      return;
    }
    settle(anchor.id, {
      ok: false,
      error: new Error(
        `Discarded anchor after quarantine: ${anchor.quarantineError ?? 'failed'}`,
      ),
    });
    store.dispatch(queueActions.removeOp(anchor.id));
    for (const op of group) {
      if (op.id === anchor.id) continue;
      store.dispatch(queueActions.requeueOp(op.id));
    }
    void drain();
  }

  // ---- box #12 cold-boot sweep ----

  function coldBootSweep() {
    const ops = store.getState().queue.ops;
    const stamp = now();
    for (const op of Object.values(ops) as QueueOp[]) {
      // Already-quarantined survives as-is.
      if (op.status === 'quarantined') continue;

      const isStaleInflight =
        op.status === 'inflight' && op.sessionId !== SESSION_ID;
      const reachedCap = op.attempts >= MAX_ATTEMPTS;

      if (reachedCap) {
        // attempts >= MAX_ATTEMPTS at boot means a previous session ran
        // the op all the way to its retry cap and crashed before
        // quarantining. Catch up. Demote to pending first so quarantine-
        // Cascade can pick it up like a normal failure.
        if (op.status !== 'pending') {
          store.dispatch(
            queueActions.patchOp({
              id: op.id,
              patch: { status: 'pending', recoveredFromCrash: isStaleInflight },
            }),
          );
        }
        quarantineCascade(
          { ...op, status: 'pending' },
          new Error('Recovered after crash and exceeded retry cap'),
        );
        continue;
      }

      if (isStaleInflight) {
        store.dispatch(
          queueActions.patchOp({
            id: op.id,
            patch: {
              status: 'pending',
              recoveredFromCrash: true,
              // Don't reset attempts — the previous session may have hit
              // the server already, so the next try counts as N+1.
            },
          }),
        );
      }
    }
    void drain();
    void stamp; // satisfy noUnusedLocals if the type config ever turns it on
  }

  return {
    registerCollection<T>(collectionId: string, handlers: CollectionHandlers<T>) {
      handlersByCollection.set(collectionId, handlers);
    },
    enqueueAndAwait<T>(op: Omit<QueueOp<T>, 'seq'>) {
      return new Promise<void>((resolve, reject) => {
        completions.set(op.id, { resolve, reject });
        store.dispatch(queueActions.enqueue(op as Omit<QueueOp, 'seq'>));
        void drain();
      });
    },
    triggerDrain() {
      // Force-clear any backed-off nextAttemptAt so retryable ops waiting
      // on backoff get a fresh shot. Matches the TanStack DB version's
      // "drain on reconnect" semantics: the network came back, try again.
      const t = now();
      const ops = store.getState().queue.ops;
      for (const op of Object.values(ops) as QueueOp[]) {
        if (
          op.status === 'pending' &&
          op.nextAttemptAt != null &&
          op.nextAttemptAt > t
        ) {
          store.dispatch(
            queueActions.patchOp({ id: op.id, patch: { nextAttemptAt: null } }),
          );
        }
      }
      void drain();
    },
    resolveServerId: resolveServerIdInternal,
    retryCascade: retryCascadeImpl,
    discardCascade: discardCascadeImpl,
    discardAnchorRequeueRest: discardAnchorRequeueRestImpl,
    async ready() {
      // PersistGate already gated render until rehydration finished, so
      // by the time consumers call ready() the state is loaded. Sweep
      // here.
      coldBootSweep();
    },
    sessionId: () => SESSION_ID,
  };
}

// Temp ids — same scheme as fe-todos so the BFF dedup store and any logs
// stay legible across both apps.
export const TEMP_ID_PREFIX = 'temp_';
export function mintTempId(): string {
  return `${TEMP_ID_PREFIX}${crypto.randomUUID()}`;
}
