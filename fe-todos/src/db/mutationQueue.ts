import { createCollection, localOnlyCollectionOptions } from '@tanstack/db';
import { persistedCollectionOptions } from '@tanstack/browser-db-sqlite-persistence';

export type QueueOpType = 'insert' | 'update' | 'delete';
export type QueueOpStatus = 'pending' | 'inflight';

export interface QueueOp {
  id: string;
  collectionId: string;
  type: QueueOpType;
  key: string;
  payload: {
    modified?: unknown;
    original?: unknown;
    changes?: unknown;
  };
  enqueuedAt: number;
  // Monotonic per-process counter that breaks ties when many ops are enqueued
  // in the same tick. `enqueuedAt` is wall-clock for diagnostics; `seq`
  // determines drain order among eligible ops.
  seq: number;
  attempts: number;
  status: QueueOpStatus;
  // Box #12: identifies which session (process lifetime) most recently
  // flipped this op to `inflight`. If a cold-boot sweep finds `inflight`
  // with a stale session id, the previous session crashed mid-write and
  // this op needs the "recovered" treatment.
  sessionId?: string;
  // Box #12: set true when the cold-boot sweep promotes this op back to
  // pending after a crash. The UI can render a "Recovered after crash"
  // badge alongside the normal "Sending…" / "Failed" states. Cleared the
  // next time the runner attempts the op.
  recoveredFromCrash?: boolean;
  // Box #9: groups ops that share a row identity (or any other consumer-
  // declared key) so cascade quarantine moves them together. Defaults to
  // `${collectionId}:${key}` when set by the wrapper.
  correlationKey: string;
  // Set on quarantined rows; explains why this op was moved out of the live
  // queue. `parent`: this op exhausted retries. `cascade`: a sibling
  // quarantined and pulled this one with it.
  quarantineReason?: 'parent' | 'cascade';
  // The error that caused parent quarantine. Cascade rows omit this.
  quarantineError?: string;
  quarantinedAt?: number;
  // Wall-clock timestamp (ms) when this op becomes eligible to run. `null`
  // means "eligible immediately". Persisted with the op, so a 25s remaining
  // backoff still waits 25s after a reload — it doesn't reset and doesn't
  // fire immediately. (Box #8.)
  nextAttemptAt: number | null;
}

// Insert handlers may return the server row so the queue can detect a temp→
// server ID change. Update/delete handlers don't need to return anything.
export type InsertHandlerResult = { serverId?: string } | void;

export interface CollectionHandlers {
  onInsert?: (op: QueueOp) => Promise<InsertHandlerResult>;
  onUpdate?: (op: QueueOp) => Promise<void>;
  onDelete?: (op: QueueOp) => Promise<void>;
}

// Box #10: previously this hooked an "optimistic reapplier" callback per
// collection so the wrapper could re-project rolled-back state. Turned out
// the simpler path is "don't settle the parent transaction on quarantine,"
// so this interface is reserved for future use if a collection adapter ever
// needs explicit reapply hooks.
export interface OptimisticReapplier {
  reapply: (op: QueueOp) => void;
  discard: (op: QueueOp) => void;
}

// A self-contained queue runner bound to a single persistence instance.
// `createMutationQueue` returns the API the wrapper and tests both depend on,
// so we never reach for a global persistence singleton.
export type RetryPolicy = (op: QueueOp) => boolean;

export interface MutationQueue {
  registerCollection(collectionId: string, handlers: CollectionHandlers): void;
  registerRetryPolicy(collectionId: string, isRetrySafe: RetryPolicy): void;
  registerOptimisticReapplier(collectionId: string, reapplier: OptimisticReapplier): void;
  enqueueOp(op: Omit<QueueOp, 'seq'>): void;
  awaitOpCompletion(opId: string): Promise<void>;
  drain(): Promise<void>;
  // Box #10: user recovery actions on a quarantined cascade.
  retryCascade(correlationKey: string): Promise<void>;
  discardCascade(correlationKey: string): Promise<void>;
  // Drop just the parent (anchor); requeue the dependents.
  discardAnchorRequeueRest(correlationKey: string): Promise<void>;
  // Box #11: trigger a drain from outside (reconnect, focus, auth refresh).
  // Coalesced behind the same mutex the wake timer uses so concurrent
  // triggers don't double-dispatch the same op.
  triggerDrain(): void;
  // Temp→server ID mapping. Persisted in the same SQLite DB so a reload mid-
  // flight still binds the right server row to the right optimistic row.
  bindServerId(collectionId: string, tempId: string, serverId: string): Promise<void>;
  // Wipes the queue, quarantine, and id-binding stores plus their in-memory
  // mirrors. Rejects every pending awaitOpCompletion deferred so consumers
  // (parent transactions) settle instead of hanging forever. Server data
  // is not touched. Used by clearAll on the FE.
  clearLocalState(): Promise<void>;
  // Fires after every successful bindServerId. The wrapper subscribes so it
  // can project still-queued ops referencing the temp id into the synced
  // cache under the new server id, masking the row before queryCollection's
  // post-ack refetch can re-introduce it. Returns an unsubscribe.
  subscribeBindings(
    listener: (binding: { collectionId: string; tempId: string; serverId: string }) => void,
  ): () => void;
  // Lookup helper used by the wrapper's bind subscriber: returns every op
  // currently in the active queue whose (collectionId, key) matches.
  pendingOpsFor(collectionId: string, key: string): Array<QueueOp>;
  resolveServerId(collectionId: string, key: string): string;
  // Render-key alias: returns the temp ID for a known binding, otherwise the
  // input. Components key React lists off this so a row doesn't unmount when
  // its underlying ID flips from temp to server.
  aliasFor(collectionId: string, key: string): string;
  // Awaits underlying persistence so the in-memory binding mirror is loaded
  // AND runs the cold-boot sweep (box #12): demotes stale `inflight` ops to
  // `pending` with `recoveredFromCrash`, sweeps anything that's already past
  // MAX_ATTEMPTS straight into quarantine, and re-arms backoff timers.
  ready(): Promise<void>;
  // Box #12: this process's session id. Stamped on ops when they flip to
  // `inflight`. Mostly useful for tests/debug; consumers shouldn't need it.
  sessionId(): string;
  // Box #9: quarantine listing. Quarantined ops are inspectable but no longer
  // drained. Box #10 added retry/discard recovery actions on top.
  quarantineList(): Array<QueueOp>;
  // React-friendly subscription. Listener fires whenever the quarantine
  // collection changes (op added or removed). Returns an unsubscribe.
  subscribeQuarantine(listener: () => void): () => void;
  // Test inspection helpers — read-only.
  size(): number;
  list(): Array<QueueOp>;
  bindings(): Array<IdBinding>;
  // Emit a `store-snapshot` log line containing the current contents of the
  // active queue, the quarantine store, and the temp→server bindings store.
  // Useful from DevTools (e.g. `mutationQueue.logSnapshot()`) to peek at what
  // is currently sitting in each SQLite-backed table.
  logSnapshot(label?: string): void;
}

export interface IdBinding {
  id: string; // `${collectionId}:${tempId}` — a stable composite key
  collectionId: string;
  tempId: string;
  serverId: string;
  boundAt: number;
}

export interface BackoffOptions {
  base?: number; // ms
  cap?: number; // ms
}

// Stage names for the mutation lifecycle. The wrapper logs higher-level
// boundaries (`enqueue`, `register`, `projection-*`, `invalidate`); the
// queue logs everything else. Consumers turn logging on by passing a
// `logger`; default is silent.
export type MutationLogStage =
  | 'enqueue'
  | 'pick'
  | 'inflight'
  | 'ack'
  | 'reject'
  | 'retry-scheduled'
  | 'retry-immediate'
  | 'quarantine'
  | 'cascade'
  | 'recovery-retry'
  | 'recovery-discard'
  | 'recovery-discard-anchor'
  | 'cold-boot-recover'
  | 'cold-boot-cap-quarantine'
  | 'trigger-drain'
  | 'offline-paused'
  | 'wake-scheduled'
  | 'bind-temp-to-server'
  | 'projection-apply'
  | 'projection-error'
  | 'invalidate'
  | 'register-collection'
  | 'clear-local-state'
  | 'store-snapshot';

export type MutationLogger = (
  stage: MutationLogStage,
  detail: Record<string, unknown>,
) => void;

export interface MutationQueueOptions {
  backoff?: BackoffOptions;
  // Test-injectable clock and timer. Production uses the global functions.
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  // Optional structured logger; default no-op.
  logger?: MutationLogger;
  // Connectivity probe. Returns true if the network is reachable.
  // Defaults to `navigator.onLine` in the browser, true in Node/tests.
  // When false, the runner pauses instead of attempting ops — connectivity
  // errors should not consume retry attempts.
  isOnline?: () => boolean;
}

export function createMutationQueue(
  persistence: any,
  options: MutationQueueOptions = {},
): MutationQueue {
  const now = options.now ?? (() => Date.now());
  const setTimer =
    options.setTimeout ?? ((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms));
  const clearTimer =
    options.clearTimeout ?? ((handle: unknown) => globalThis.clearTimeout(handle as any));
  const BACKOFF_BASE = options.backoff?.base ?? 500;
  const BACKOFF_CAP = options.backoff?.cap ?? 30_000;
  const log: MutationLogger = options.logger ?? (() => {});
  const isOnline =
    options.isOnline ??
    (() => {
      // navigator.onLine is missing in non-browser runtimes — treat as online
      // there so tests and Node-side persistence aren't artificially paused.
      const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
      return nav?.onLine ?? true;
    });
  const queue = createCollection(
    persistedCollectionOptions({
      ...(localOnlyCollectionOptions<QueueOp, string>({
        id: 'mutation-queue',
        getKey: (op) => op.id,
      }) as any),
      persistence,
      schemaVersion: 1,
    }),
  );

  const idBindings = createCollection(
    persistedCollectionOptions({
      ...(localOnlyCollectionOptions<IdBinding, string>({
        id: 'id-bindings',
        getKey: (b) => b.id,
      }) as any),
      persistence,
      schemaVersion: 1,
    }),
  );

  // Box #9: quarantined ops live in their own collection so they don't
  // pollute the active queue's drain loop.
  const quarantine = createCollection(
    persistedCollectionOptions({
      ...(localOnlyCollectionOptions<QueueOp, string>({
        id: 'mutation-quarantine',
        getKey: (op) => op.id,
      }) as any),
      persistence,
      schemaVersion: 1,
    }),
  );

  function bindingKey(collectionId: string, tempId: string) {
    return `${collectionId}:${tempId}`;
  }

  // In-memory mirror of the persisted binding rows; populated on first read
  // so the runner doesn't have to re-iterate the DB collection on every op.
  const tempToServer = new Map<string, string>();
  const serverToTemp = new Map<string, string>();
  let bindingsLoaded = false;
  function ensureBindingsLoaded() {
    if (bindingsLoaded) return;
    for (const b of idBindings.values() as Iterable<IdBinding>) {
      tempToServer.set(bindingKey(b.collectionId, b.tempId), b.serverId);
      serverToTemp.set(bindingKey(b.collectionId, b.serverId), b.tempId);
    }
    bindingsLoaded = true;
  }

  const handlersByCollection = new Map<string, CollectionHandlers>();
  const retryPolicyByCollection = new Map<string, RetryPolicy>();
  const reappliersByCollection = new Map<string, OptimisticReapplier>();
  const completionByOpId = new Map<string, { resolve: () => void; reject: (e: unknown) => void }>();
  // Box #12: a fresh id per createMutationQueue call. Stamped on every op
  // that goes inflight; the cold-boot sweep uses it to spot ops left
  // inflight by a previous (crashed) session.
  const SESSION_ID = crypto.randomUUID();
  let draining = false;

  // Soft cap until box #9 adds proper quarantine. A retrySafe op that keeps
  // failing must terminate eventually rather than retry forever.
  const MAX_ATTEMPTS = 5;

  function backoffMsForAttempts(attempts: number): number {
    return Math.min(BACKOFF_BASE * Math.pow(2, attempts - 1), BACKOFF_CAP);
  }

  function settle(opId: string, result: { ok: true } | { ok: false; error: unknown }) {
    const deferred = completionByOpId.get(opId);
    if (!deferred) return;
    completionByOpId.delete(opId);
    if (result.ok) deferred.resolve();
    else deferred.reject(result.error);
  }

  function rewriteKeyForDispatch(op: QueueOp): QueueOp {
    // Update/delete ops queued under a temp ID need to target the bound
    // server ID once the create acks. Insert ops keep the temp ID — that's
    // the contract their handler signed up for.
    if (op.type === 'insert') return op;
    ensureBindingsLoaded();
    const serverId = tempToServer.get(bindingKey(op.collectionId, op.key));
    if (!serverId) return op;
    return { ...op, key: serverId };
  }

  async function runOp(op: QueueOp) {
    const handlers = handlersByCollection.get(op.collectionId);
    if (!handlers) {
      throw new Error(`No handlers registered for collection "${op.collectionId}"`);
    }
    const dispatchOp = rewriteKeyForDispatch(op);
    if (op.type === 'insert') {
      const handler = handlers.onInsert;
      if (!handler) {
        throw new Error(`No insert handler registered for collection "${op.collectionId}"`);
      }
      const result = await handler(dispatchOp);
      const serverId = result?.serverId;
      if (serverId && serverId !== op.key) {
        await bindServerIdInternal(op.collectionId, op.key, serverId);
      }
      return;
    }
    const handler = op.type === 'update' ? handlers.onUpdate : handlers.onDelete;
    if (!handler) {
      throw new Error(`No ${op.type} handler registered for collection "${op.collectionId}"`);
    }
    await handler(dispatchOp);
  }

  async function bindServerIdInternal(collectionId: string, tempId: string, serverId: string) {
    ensureBindingsLoaded();
    const k = bindingKey(collectionId, tempId);
    if (tempToServer.get(k) === serverId) return;
    tempToServer.set(k, serverId);
    serverToTemp.set(bindingKey(collectionId, serverId), tempId);
    const tx = idBindings.insert({
      id: k,
      collectionId,
      tempId,
      serverId,
      boundAt: Date.now(),
    } as any);
    // Wait for persistence to flush so a crash right after this resolves
    // doesn't lose the binding.
    await tx.isPersisted.promise;
    log('bind-temp-to-server', {
      collectionId,
      tempId,
      serverId,
      bindingsSize: idBindings.size,
    });
    // Notify subscribers so the wrapper can project still-queued ops
    // referencing the temp id into the synced cache under the new server
    // id. Suppresses the brief flicker between the create's auto-refetch
    // (which would re-introduce the row) and the eventual delete drain.
    for (const listener of bindingListeners) {
      try {
        listener({ collectionId, tempId, serverId });
      } catch (err) {
        // Best-effort fan-out; don't let one bad listener break the runner.
        console.warn('[durableQueue] subscribeBindings listener threw:', err);
      }
    }
  }

  const bindingListeners = new Set<
    (binding: { collectionId: string; tempId: string; serverId: string }) => void
  >();

  // Returns the next op eligible to run *now*. An op is eligible when its
  // status is pending and its nextAttemptAt is null or in the past.
  function pickNextPending(currentTime: number): QueueOp | undefined {
    let best: QueueOp | undefined;
    for (const row of queue.values() as Iterable<QueueOp>) {
      if (row.status !== 'pending') continue;
      if (row.nextAttemptAt != null && row.nextAttemptAt > currentTime) continue;
      if (!best || row.seq < best.seq) best = row;
    }
    return best;
  }

  // Among pending ops not yet eligible, the earliest scheduled time.
  function earliestScheduledTime(currentTime: number): number | null {
    let earliest: number | null = null;
    for (const row of queue.values() as Iterable<QueueOp>) {
      if (row.status !== 'pending') continue;
      if (row.nextAttemptAt == null || row.nextAttemptAt <= currentTime) continue;
      if (earliest == null || row.nextAttemptAt < earliest) earliest = row.nextAttemptAt;
    }
    return earliest;
  }

  // Move `parent` (the op that exhausted retries) plus every queued
  // *dependent* op into the quarantine store. A dependent is any op sharing
  // the same correlation key — but only when the failed parent is itself an
  // insert (the row's anchor). Otherwise cascade would over-quarantine
  // unrelated edits to a server-bound row. Box #5 verifies that contract;
  // box #9 verifies the create→child cascade case.
  //
  // Box #10: after moving each op to quarantine, reapply its optimistic state
  // to the wrapped collection so the row stays visible (e.g. with a failed
  // badge). Without this, TanStack DB's rejection of the parent tx would
  // also wipe the optimistic state, defeating the "discard / retry" UX.
  async function quarantineCascade(parent: QueueOp, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const stamp = now();

    const cascade: Array<QueueOp> =
      parent.type === 'insert'
        ? Array.from(queue.values() as Iterable<QueueOp>).filter(
            (row) => row.correlationKey === parent.correlationKey && row.id !== parent.id,
          )
        : [];

    const parentRow: QueueOp = {
      ...parent,
      status: 'pending',
      nextAttemptAt: null,
      quarantineReason: 'parent',
      quarantineError: message,
      quarantinedAt: stamp,
    };
    quarantine.insert(parentRow as any);
    queue.delete(parent.id);
    log('quarantine', {
      opId: parent.id,
      collectionId: parent.collectionId,
      type: parent.type,
      key: parent.key,
      attempts: parent.attempts,
      error: message,
      cascadeSize: cascade.length,
      correlationKey: parent.correlationKey,
      payload: parent.payload,
      queueDepth: queue.size,
      quarantineSize: quarantine.size,
    });
    // Crucially: don't settle the parent transaction. TanStack DB keeps the
    // optimistic state active until the deferred resolves; leaving it pending
    // means the row stays visible in the UI as the user "still has work in
    // flight." The recovery actions (retry / discard) finalize it later.
    // Quarantine surfaces the failure through `quarantineList()` for the UI.

    for (const sibling of cascade) {
      const cascadeRow: QueueOp = {
        ...sibling,
        status: 'pending',
        nextAttemptAt: null,
        quarantineReason: 'cascade',
        quarantinedAt: stamp,
      };
      quarantine.insert(cascadeRow as any);
      queue.delete(sibling.id);
      log('cascade', {
        opId: sibling.id,
        type: sibling.type,
        key: sibling.key,
        anchorOpId: parent.id,
        correlationKey: parent.correlationKey,
        payload: sibling.payload,
        queueDepth: queue.size,
        quarantineSize: quarantine.size,
      });
      // Same reasoning as the parent: leave the deferred pending so the
      // dependent op's optimistic state stays visible.
    }
  }

  // ---- Box #10: recovery actions ----

  function quarantinedByCorrelation(correlationKey: string): Array<QueueOp> {
    return Array.from(quarantine.values() as Iterable<QueueOp>).filter(
      (row) => row.correlationKey === correlationKey,
    );
  }

  function moveOpFromQuarantineToActive(op: QueueOp) {
    const fresh: QueueOp = {
      ...op,
      attempts: 0,
      status: 'pending',
      nextAttemptAt: null,
      quarantineReason: undefined,
      quarantineError: undefined,
      quarantinedAt: undefined,
      // Bump seq so requeued ops don't compete with brand-new ones.
      seq: nextSeq++,
    };
    queue.insert(fresh as any);
    quarantine.delete(op.id);
  }

  async function retryCascade(correlationKey: string) {
    const group = quarantinedByCorrelation(correlationKey);
    log('recovery-retry', {
      correlationKey,
      count: group.length,
      ops: group.map((op) => ({ opId: op.id, type: op.type, key: op.key })),
    });
    // Anchor first so dependents drain after it lands.
    group.sort((a, b) => a.seq - b.seq);
    for (const op of group) moveOpFromQuarantineToActive(op);
    void drain();
  }

  async function discardCascade(correlationKey: string) {
    const group = quarantinedByCorrelation(correlationKey);
    log('recovery-discard', {
      correlationKey,
      count: group.length,
      ops: group.map((op) => ({ opId: op.id, type: op.type, key: op.key })),
    });
    for (const op of group) {
      // Settle the still-pending parent deferred with a discard error so
      // TanStack DB rolls back the optimistic state for this op's row.
      settle(op.id, {
        ok: false,
        error: new Error(
          op.quarantineReason === 'parent'
            ? `Discarded after quarantine: ${op.quarantineError ?? 'failed'}`
            : `Discarded as part of cascade from quarantined op`,
        ),
      });
      quarantine.delete(op.id);
    }
  }

  async function discardAnchorRequeueRestImpl(correlationKey: string) {
    const group = quarantinedByCorrelation(correlationKey);
    if (group.length === 0) return;
    const anchor = group.find((op) => op.quarantineReason === 'parent');
    log('recovery-discard-anchor', {
      correlationKey,
      anchorOpId: anchor?.id,
      requeueCount: group.length - (anchor ? 1 : 0),
    });
    if (!anchor) {
      // No parent in this group — nothing to anchor-discard. Treat as a
      // plain retry of the dependents.
      for (const op of group) moveOpFromQuarantineToActive(op);
      void drain();
      return;
    }
    settle(anchor.id, {
      ok: false,
      error: new Error(
        `Discarded anchor after quarantine: ${anchor.quarantineError ?? 'failed'}`,
      ),
    });
    quarantine.delete(anchor.id);
    for (const op of group) {
      if (op.id === anchor.id) continue;
      moveOpFromQuarantineToActive(op);
    }
    void drain();
  }

  // Box #11: when a trigger fires while the runner is already mid-drain, we
  // remember that someone asked us to look again and re-drain after the
  // current pass finishes. Without this, an ack-then-trigger sequence could
  // miss work.
  let drainRequestedDuringDrain = false;

  let wakeTimer: unknown = null;
  function scheduleWake(currentTime: number) {
    if (wakeTimer != null) {
      clearTimer(wakeTimer);
      wakeTimer = null;
    }
    const earliest = earliestScheduledTime(currentTime);
    if (earliest == null) return;
    const delay = Math.max(0, earliest - currentTime);
    log('wake-scheduled', { delayMs: delay, dueAt: earliest });
    wakeTimer = setTimer(() => {
      wakeTimer = null;
      void drain();
    }, delay);
  }

  async function drain() {
    if (draining) {
      drainRequestedDuringDrain = true;
      return;
    }
    draining = true;
    drainRequestedDuringDrain = false;
    try {
      while (true) {
        // Offline gate: don't pick or attempt anything when the network is
        // unreachable. The `online` event (wired via attachDrainTriggers)
        // will fire triggerDrain() once we're back, which clears any
        // backed-off nextAttemptAt and re-enters this loop. Connectivity
        // errors never burn through MAX_ATTEMPTS this way.
        if (!isOnline()) {
          log('offline-paused', {});
          return;
        }
        const t = now();
        const head = pickNextPending(t);
        if (!head) {
          // Nothing eligible now; if a backed-off op is scheduled later, arm
          // the wake-up timer for the earliest one.
          scheduleWake(t);
          return;
        }

        log('pick', {
          opId: head.id,
          collectionId: head.collectionId,
          type: head.type,
          key: head.key,
          attempts: head.attempts,
        });
        queue.update(head.id, (draft: any) => {
          draft.status = 'inflight';
          draft.attempts += 1;
          draft.nextAttemptAt = null;
          draft.sessionId = SESSION_ID;
          // The next attempt clears the "recovered" badge — once we're
          // actually trying it in this session, "Sending…" is the right UI.
          draft.recoveredFromCrash = false;
        });
        log('inflight', { opId: head.id, attempt: head.attempts + 1 });

        try {
          await runOp(head);
          queue.delete(head.id);
          settle(head.id, { ok: true });
          log('ack', {
            opId: head.id,
            collectionId: head.collectionId,
            type: head.type,
            key: head.key,
            queueDepth: queue.size,
          });
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          log('reject', {
            opId: head.id,
            collectionId: head.collectionId,
            type: head.type,
            key: head.key,
            attempt: head.attempts + 1,
            error: errMsg,
          });
          // Box #7: honor retrySafe. Box #8: retryable ops are scheduled for
          // a future attempt via exponential backoff, persisted on the row
          // so a reload mid-wait still respects the remaining time.
          const policy = retryPolicyByCollection.get(head.collectionId);
          const retryable = policy ? policy(head) : false;
          const attemptsSoFar = head.attempts + 1;
          const reachedCap = attemptsSoFar >= MAX_ATTEMPTS;
          if (retryable && !reachedCap) {
            const delay = backoffMsForAttempts(attemptsSoFar);
            const dueAt = now() + delay;
            queue.update(head.id, (draft: any) => {
              draft.status = 'pending';
              draft.nextAttemptAt = dueAt;
            });
            if (delay > 0) {
              log('retry-scheduled', {
                opId: head.id,
                attempts: attemptsSoFar,
                delayMs: delay,
                dueAt,
              });
              // Exit the loop and let the wake timer call drain() again
              // when the op comes due. Avoids busy-waiting on the queue.
              scheduleWake(now());
              return;
            }
            log('retry-immediate', { opId: head.id, attempts: attemptsSoFar });
            // delay === 0: keep looping. The TanStack DB update above
            // applies in this microtask, so the next pickNextPending sees
            // the op as still pending and immediately eligible.
            continue;
          } else {
            // Box #9: terminal failure (or retry cap hit) → quarantine the
            // op AND any siblings sharing its correlation key. The parent
            // transaction still rejects so TanStack DB rolls back the
            // optimistic state today; box #10 will add the user-facing
            // retry/discard recovery actions.
            await quarantineCascade(head, error);
          }
        }
      }
    } finally {
      draining = false;
      // If a trigger fired while we were draining, run another pass now to
      // pick up any newly eligible op (e.g. one whose nextAttemptAt slipped
      // past now() while we were busy with another op).
      if (drainRequestedDuringDrain) {
        drainRequestedDuringDrain = false;
        void drain();
      }
    }
  }

  let nextSeq = 0;

  // Box #12: cold-boot sweep. Walks the persisted queue once and reconciles
  // it with this session's reality:
  //   - inflight ops with a foreign sessionId are crash leftovers; demote to
  //     pending and flag `recoveredFromCrash` so the UI can warn.
  //   - ops at or past MAX_ATTEMPTS go straight to quarantine without trying
  //     again — they're already known-failed.
  //   - regular pending ops with a future nextAttemptAt: leave as-is. The
  //     first drain call will scheduleWake() and pick them up at the right
  //     time.
  function coldBootSweep() {
    const survivors: Array<QueueOp> = [];
    for (const op of queue.values() as Iterable<QueueOp>) {
      const isStaleInflight = op.status === 'inflight' && op.sessionId !== SESSION_ID;
      // attempts >= MAX_ATTEMPTS at boot means a previous session ran the
      // op all the way to its retry cap and crashed before quarantining.
      // Catch up on the quarantine that should have happened.
      const reachedCap = op.attempts >= MAX_ATTEMPTS;

      if (reachedCap) {
        survivors.push({
          ...op,
          status: 'pending', // quarantineCascade reads from `queue`, so the op
                              // must be there to be moved out of it.
          recoveredFromCrash: isStaleInflight ? true : op.recoveredFromCrash,
        });
        continue;
      }

      if (isStaleInflight) {
        log('cold-boot-recover', {
          opId: op.id,
          collectionId: op.collectionId,
          type: op.type,
          attempts: op.attempts,
          previousSessionId: op.sessionId,
        });
        queue.update(op.id, (draft: any) => {
          draft.status = 'pending';
          draft.recoveredFromCrash = true;
          // Don't reset attempts — the previous session may well have hit
          // the server already, so this becomes attempt N+1.
        });
      }
      // pending + future nextAttemptAt is already correct; drain() will
      // arm a wake timer for the earliest one.
    }

    // Quarantine sweep — done after the iteration so we don't mutate the
    // queue while iterating.
    for (const op of survivors) {
      log('cold-boot-cap-quarantine', {
        opId: op.id,
        collectionId: op.collectionId,
        attempts: op.attempts,
      });
      void quarantineCascade(
        op,
        new Error('Recovered after crash and exceeded retry cap'),
      );
    }

    // Kick off a drain in case anything is eligible right now.
    void drain();
  }

  return {
    registerCollection(collectionId, handlers) {
      handlersByCollection.set(collectionId, handlers);
      log('register-collection', { collectionId });
    },
    registerRetryPolicy(collectionId, isRetrySafe) {
      retryPolicyByCollection.set(collectionId, isRetrySafe);
    },
    registerOptimisticReapplier(collectionId, reapplier) {
      reappliersByCollection.set(collectionId, reapplier);
    },
    retryCascade,
    discardCascade,
    discardAnchorRequeueRest: discardAnchorRequeueRestImpl,
    triggerDrain() {
      // Force-clear any backed-off `nextAttemptAt` so retryable ops that
      // were waiting on backoff get a fresh shot. This matches the spec's
      // "drain on reconnect" semantics: the network came back, try again.
      const t = now();
      let cleared = 0;
      for (const row of queue.values() as Iterable<QueueOp>) {
        if (row.status === 'pending' && row.nextAttemptAt != null && row.nextAttemptAt > t) {
          queue.update(row.id, (draft: any) => {
            draft.nextAttemptAt = null;
          });
          cleared++;
        }
      }
      log('trigger-drain', { backoffsCleared: cleared });
      void drain();
    },
    enqueueOp(op) {
      const seq = nextSeq++;
      queue.insert({ ...op, seq, nextAttemptAt: op.nextAttemptAt ?? null } as any);
      log('enqueue', {
        opId: op.id,
        collectionId: op.collectionId,
        type: op.type,
        key: op.key,
        correlationKey: op.correlationKey,
        seq,
        payload: op.payload,
        queueDepth: queue.size,
        quarantineSize: quarantine.size,
      });
      void drain();
    },
    awaitOpCompletion(opId) {
      return new Promise((resolve, reject) => {
        completionByOpId.set(opId, { resolve, reject });
      });
    },
    drain,
    bindServerId: bindServerIdInternal,
    subscribeBindings(listener) {
      bindingListeners.add(listener);
      return () => {
        bindingListeners.delete(listener);
      };
    },
    pendingOpsFor(collectionId, key) {
      const out: Array<QueueOp> = [];
      for (const row of queue.values() as Iterable<QueueOp>) {
        if (row.collectionId === collectionId && row.key === key) out.push(row);
      }
      return out;
    },
    resolveServerId(collectionId, key) {
      ensureBindingsLoaded();
      return tempToServer.get(bindingKey(collectionId, key)) ?? key;
    },
    aliasFor(collectionId, key) {
      ensureBindingsLoaded();
      return serverToTemp.get(bindingKey(collectionId, key)) ?? key;
    },
    async ready() {
      await Promise.all([queue.preload(), idBindings.preload(), quarantine.preload()]);
      bindingsLoaded = false; // force reload after preload completes
      ensureBindingsLoaded();
      this.logSnapshot('post-preload');
      coldBootSweep();
      this.logSnapshot('post-cold-boot-sweep');
    },
    sessionId: () => SESSION_ID,
    quarantineList: () => Array.from(quarantine.values() as Iterable<QueueOp>),
    subscribeQuarantine(listener) {
      const sub = quarantine.subscribeChanges(() => listener());
      return () => sub.unsubscribe();
    },
    async clearLocalState() {
      const before = {
        queue: queue.size,
        quarantine: quarantine.size,
        bindings: idBindings.size,
        pendingDeferreds: completionByOpId.size,
      };
      // Reject every pending awaitOpCompletion deferred so parent
      // transactions don't hang. Caller's perspective: their mutation
      // failed with a `Local data cleared` error, TanStack DB rolls back
      // the optimistic state, the row disappears.
      const cleanupError = new Error('Local data cleared');
      for (const [opId, deferred] of completionByOpId) {
        try {
          deferred.reject(cleanupError);
        } catch {
          // ignore
        }
        completionByOpId.delete(opId);
      }
      // Cancel any wake timer so a stale drain doesn't fire post-clear.
      if (wakeTimer != null) {
        clearTimer(wakeTimer);
        wakeTimer = null;
      }
      // Wipe persisted rows. We use the collections' own delete semantics so
      // the persistence layer's tracking stays consistent.
      for (const op of queue.values() as Iterable<QueueOp>) queue.delete(op.id);
      for (const op of quarantine.values() as Iterable<QueueOp>) quarantine.delete(op.id);
      for (const b of idBindings.values() as Iterable<IdBinding>) idBindings.delete(b.id);
      // In-memory mirrors.
      tempToServer.clear();
      serverToTemp.clear();
      bindingsLoaded = true; // bindings collection is empty, no reload needed
      // Reset draining flag so a future trigger drains cleanly.
      draining = false;
      drainRequestedDuringDrain = false;
      log('clear-local-state', {
        cleared: before,
        after: {
          queue: queue.size,
          quarantine: quarantine.size,
          bindings: idBindings.size,
          pendingDeferreds: completionByOpId.size,
        },
      });
    },
    size: () => queue.size,
    list: () => Array.from(queue.values() as Iterable<QueueOp>),
    bindings: () => Array.from(idBindings.values() as Iterable<IdBinding>),
    logSnapshot(label?: string) {
      log('store-snapshot', {
        label: label ?? 'manual',
        sessionId: SESSION_ID,
        queue: Array.from(queue.values() as Iterable<QueueOp>).map((op) => ({
          opId: op.id,
          collectionId: op.collectionId,
          type: op.type,
          key: op.key,
          status: op.status,
          attempts: op.attempts,
          seq: op.seq,
          correlationKey: op.correlationKey,
          nextAttemptAt: op.nextAttemptAt,
          recoveredFromCrash: op.recoveredFromCrash ?? false,
        })),
        quarantine: Array.from(quarantine.values() as Iterable<QueueOp>).map((op) => ({
          opId: op.id,
          collectionId: op.collectionId,
          type: op.type,
          key: op.key,
          reason: op.quarantineReason,
          error: op.quarantineError,
          attempts: op.attempts,
          correlationKey: op.correlationKey,
        })),
        bindings: Array.from(idBindings.values() as Iterable<IdBinding>).map((b) => ({
          collectionId: b.collectionId,
          tempId: b.tempId,
          serverId: b.serverId,
        })),
      });
    },
  };
}
