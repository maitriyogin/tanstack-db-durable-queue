import {
  queryCollectionOptions,
  type QueryCollectionConfig,
} from '@tanstack/query-db-collection';
import { persistedCollectionOptions } from '@tanstack/browser-db-sqlite-persistence';
import type { QueryKey } from '@tanstack/query-core';
import type {
  MutationLogger,
  MutationQueue,
  QueueOp,
  QueueOpType,
} from './mutationQueue';

// A collection-options creator that layers durable queue / quarantine concerns
// on top of `queryCollectionOptions`. Callers use the returned config with
// `createCollection` exactly like `queryCollectionOptions` today; live queries
// against the resulting collection are unchanged.
//
// Each mutation is durably enqueued before the optimistic state is committed.
// The wrapper's onInsert/onUpdate/onDelete await the queue runner finishing
// the op, so TanStack DB keeps the optimistic state until the server lands
// (or rolls back on terminal failure).
export interface DurableQueueConfig<T extends object> extends QueryCollectionConfig<T> {
  collectionId: string;
  schemaVersion?: number;
  persistence: any;
  queue: MutationQueue;
  // Sibling query keys to invalidate after a mutation acks. Box #3 of the
  // coverage list: consumers shouldn't have to remember to invalidate
  // dependent queries (audit counts, derived totals, etc.) by hand.
  // A function form gets the op so per-op-type invalidation is possible.
  invalidates?:
    | ReadonlyArray<QueryKey>
    | ((op: QueueOp) => ReadonlyArray<QueryKey>);
  // Multi-collection projections (box #5/#6 of the coverage list). A single
  // mutation may declare side-effect writes to other collections; each one
  // has its own optimistic apply, server apply, and error policy. Today's
  // audit-log write is the canonical example.
  projections?: Record<string, ProjectionDef>;
  // Box #7: which ops are safe to retry on failure. Non-retryable ops fail
  // terminally on their first error (today's behavior). Retryable ops stay
  // enqueued and re-drain. Object form is sugar for the function form.
  retrySafe?:
    | RetrySafeMap
    | ((op: QueueOp) => boolean);
  // Box #9: cascade key. Ops sharing a correlation key quarantine as a
  // group (so a child update can't strand if its parent create never
  // landed). Default: row identity (`${collectionId}:${key}`), with temp→
  // server binding resolution so a queued update on temp_X is still grouped
  // with its insert after the bind.
  correlationKey?: (op: QueueOp) => string;
  // Optional logger for wrapper-level events (projection apply/error,
  // invalidate). Pair with `createMutationQueue({ logger })` to get a full
  // mutation-flow trace through one channel.
  logger?: MutationLogger;
}

export interface RetrySafeMap {
  insert?: boolean;
  update?: boolean;
  delete?: boolean;
}

// `cascade` — projection failure rolls the parent op back. Use for hard
//             dependencies (e.g. inventory decrement on a sale).
// `tolerate` — projection failure is logged and dropped; parent succeeds.
//              Default. Matches today's audit-log behavior.
// `quarantine` — projection failure quarantines *the projection alone* on a
//                future task; for now it behaves like `tolerate`.
export type ProjectionErrorPolicy = 'cascade' | 'tolerate' | 'quarantine';

export interface ProjectionDef {
  // Server apply for this projection. Throwing triggers the error policy.
  apply: (op: QueueOp) => Promise<void>;
  // Optional optimistic apply against a sibling collection. Returns a thunk
  // that rolls the optimistic state back if the parent op (or this projection
  // under `cascade`) fails.
  optimistic?: (op: QueueOp) => (() => void) | void;
  onError?: ProjectionErrorPolicy;
}

type SyncTransaction<T> = {
  mutations: Array<{
    key: string | number;
    modified?: T;
    original?: T;
    changes?: Partial<T>;
  }>;
};

export function durableQueueCollectionOptions<T extends object>(
  config: DurableQueueConfig<T>,
) {
  const {
    collectionId,
    schemaVersion = 1,
    persistence,
    queue,
    invalidates,
    projections,
    retrySafe,
    correlationKey,
    logger,
    onInsert,
    onUpdate,
    onDelete,
    ...queryConfig
  } = config;
  const log: MutationLogger = logger ?? (() => {});

  // Default cascade key: collection + (server id if bound, else key). Means
  // a queued update on temp_X groups with its insert *after* the temp→server
  // bind too, so cascade quarantine catches sibling ops even when the temp
  // id has flipped.
  function defaultCorrelationKey(op: QueueOp): string {
    const resolved = queue.resolveServerId(op.collectionId, op.key);
    return `${op.collectionId}:${resolved}`;
  }
  const computeCorrelationKey = correlationKey ?? defaultCorrelationKey;

  // Defaults: only updates are retryable. Inserts and deletes are not safe
  // to repeat without server-side idempotency keys, so the consumer must
  // opt in explicitly.
  const retrySafeMap: Required<RetrySafeMap> = {
    insert: false,
    update: true,
    delete: false,
    ...(retrySafe && typeof retrySafe === 'object' ? retrySafe : {}),
  };

  function isOpRetrySafe(op: QueueOp): boolean {
    if (typeof retrySafe === 'function') return retrySafe(op);
    return retrySafeMap[op.type];
  }

  queue.registerRetryPolicy(collectionId, isOpRetrySafe);

  // After the user's handler resolves we invalidate sibling queries so their
  // collections refetch. The primary collection's own query refetches
  // automatically via queryCollectionOptions.
  async function invalidateSiblings(op: QueueOp) {
    if (!invalidates || !queryConfig.queryClient) return;
    const keys = typeof invalidates === 'function' ? invalidates(op) : invalidates;
    if (keys.length === 0) return;
    log('invalidate', { opId: op.id, keys: keys.map((k) => k as unknown) });
    await Promise.all(
      keys.map((queryKey) => queryConfig.queryClient!.invalidateQueries({ queryKey })),
    );
  }

  // Run projections sequentially after the parent's server apply succeeds.
  // We collect rollback thunks for any optimistic projections; a `cascade`
  // failure invokes them all (in reverse) and rethrows so the parent op
  // rolls back too.
  async function runProjections(op: QueueOp, parentRollbacks: Array<() => void>) {
    if (!projections) return;
    for (const [name, projection] of Object.entries(projections)) {
      const optimisticRollback = projection.optimistic?.(op) ?? (() => {});
      try {
        await projection.apply(op);
        log('projection-apply', { opId: op.id, projection: name });
      } catch (err) {
        const policy = projection.onError ?? 'tolerate';
        const errMsg = err instanceof Error ? err.message : String(err);
        log('projection-error', { opId: op.id, projection: name, policy, error: errMsg });
        if (policy === 'cascade') {
          // Roll back this projection's optimistic state, then signal the
          // parent runner that the op failed terminally.
          try { optimisticRollback(); } catch {}
          // Roll back any earlier projections that already applied.
          while (parentRollbacks.length) {
            try { parentRollbacks.pop()!(); } catch {}
          }
          throw new Error(
            `Projection "${name}" cascaded failure: ${errMsg}`,
          );
        }
        // tolerate / quarantine — log and move on. (Quarantine semantics
        // beyond logging arrive with task #9.)
        console.warn(
          `[durableQueue] projection "${name}" failed (${policy}):`,
          err,
        );
        try { optimisticRollback(); } catch {}
        continue;
      }
      parentRollbacks.push(optimisticRollback);
    }
  }

  // The runner re-dispatches the same op (same `op.id`) on retry, so handlers
  // can use `transaction.clientOpId` as the X-Client-Op-Id header — the BFF's
  // IdempotencyInterceptor dedupes against it. For fan-out handlers (e.g.
  // shopping-list syncItems) derive sub-ids per HTTP call so each cached row
  // is unique.
  queue.registerCollection(collectionId, {
    onInsert: onInsert
      ? async (op) => {
          const result = (await onInsert({
            transaction: {
              clientOpId: op.id,
              mutations: [
                { key: op.key, modified: op.payload.modified as T },
              ],
            } as any,
          } as any)) as { serverId?: string } | void;
          const rollbacks: Array<() => void> = [];
          await runProjections(op, rollbacks);
          await invalidateSiblings(op);
          return result ?? undefined;
        }
      : undefined,
    onUpdate: onUpdate
      ? async (op) => {
          await onUpdate({
            transaction: {
              clientOpId: op.id,
              mutations: [
                {
                  key: op.key,
                  modified: op.payload.modified as T,
                  original: op.payload.original as T,
                  changes: op.payload.changes as Partial<T>,
                },
              ],
            } as any,
          } as any);
          const rollbacks: Array<() => void> = [];
          await runProjections(op, rollbacks);
          await invalidateSiblings(op);
        }
      : undefined,
    onDelete: onDelete
      ? async (op) => {
          await onDelete({
            transaction: {
              clientOpId: op.id,
              mutations: [
                { key: op.key, original: op.payload.original as T },
              ],
            } as any,
          } as any);
          const rollbacks: Array<() => void> = [];
          await runProjections(op, rollbacks);
          await invalidateSiblings(op);
        }
      : undefined,
  });

  function buildOp(
    type: QueueOpType,
    m: SyncTransaction<T>['mutations'][number],
  ): Omit<QueueOp, 'seq'> {
    const draft: Omit<QueueOp, 'seq' | 'correlationKey'> = {
      id: crypto.randomUUID(),
      collectionId,
      type,
      key: String(m.key),
      payload:
        type === 'insert' ? { modified: m.modified }
        : type === 'update' ? { modified: m.modified, original: m.original, changes: m.changes }
        : { original: m.original },
      enqueuedAt: Date.now(),
      attempts: 0,
      status: 'pending',
      nextAttemptAt: null,
    };
    return {
      ...draft,
      correlationKey: computeCorrelationKey(draft as QueueOp),
    };
  }

  const baseQueryConfig = queryCollectionOptions<T>({
    ...queryConfig,
    onInsert: async ({ transaction }: { transaction: SyncTransaction<T> }) => {
      const op = buildOp('insert', transaction.mutations[0]!);
      queue.enqueueOp(op);
      await queue.awaitOpCompletion(op.id);
    },
    onUpdate: async ({ transaction }: { transaction: SyncTransaction<T> }) => {
      const op = buildOp('update', transaction.mutations[0]!);
      queue.enqueueOp(op);
      await queue.awaitOpCompletion(op.id);
    },
    onDelete: async ({ transaction }: { transaction: SyncTransaction<T> }) => {
      const op = buildOp('delete', transaction.mutations[0]!);
      queue.enqueueOp(op);
      await queue.awaitOpCompletion(op.id);
    },
  } as unknown as QueryCollectionConfig<T>);

  return persistedCollectionOptions({
    ...(baseQueryConfig as any),
    persistence,
    schemaVersion,
  });
}

// Temp IDs are prefixed so consumers and the wrapper can both recognize them
// without a side table. The runner binds `temp_*` → server id when `onInsert`
// returns `{ serverId }`.
export const TEMP_ID_PREFIX = 'temp_';
export function mintTempId(): string {
  return `${TEMP_ID_PREFIX}${crypto.randomUUID()}`;
}
export function isTempId(id: string): boolean {
  return id.startsWith(TEMP_ID_PREFIX);
}

// Wires up the wrapper's two post-construction needs:
//
// 1. Quarantine reapply (Box #10) — currently a no-op; quarantined ops keep
//    their optimistic state visible by simply not settling their parent
//    transaction. Recovery actions (`retryCascade` / `discardCascade` /
//    `discardAnchorRequeueRest`) are what eventually settle them.
//
// 2. Write-through-bind — when a temp id binds to a server id, project any
//    still-queued ops (delete / update) referencing the temp id into the
//    synced cache under the server id. Suppresses the brief flicker that
//    would otherwise happen between the create's auto-refetch (which lands
//    the new server-id row in the cache) and the eventual delete drain.
//    Critical for the offline cascade-delete case: an offline create + delete
//    pair would otherwise show the row briefly on reconnect.
export function connectQuarantineReapplier(args: {
  collection: any;
  queue: MutationQueue;
  collectionId: string;
}) {
  const { collection, queue, collectionId } = args;
  const utils = collection.utils ?? {};

  queue.subscribeBindings(({ collectionId: cid, tempId, serverId }) => {
    if (cid !== collectionId) return;
    // Walk every still-queued op for this row and project its outcome under
    // the new server id directly into the synced cache. We bypass the queue
    // (using `utils.writeDelete` / `utils.writeUpsert`) so we don't loop
    // back through `onDelete` / `onUpdate`; those will run for the *real*
    // queued op when it eventually drains.
    for (const op of queue.pendingOpsFor(collectionId, tempId)) {
      try {
        if (op.type === 'delete' && utils.writeDelete) {
          utils.writeDelete(serverId);
        } else if (op.type === 'update' && utils.writeUpsert) {
          // Re-project the modified payload under the server id.
          const modified = op.payload.modified as Record<string, unknown> | undefined;
          if (modified) utils.writeUpsert({ ...modified, id: serverId });
        }
        // No translation needed for `insert` — it's the op whose ack just
        // produced this bind, and the queryFn refetch reconciles it.
      } catch (err) {
        // Best-effort; the op will still run server-side via its queued
        // dispatch, the eventual refetch will catch up.
        console.warn(
          '[durableQueue] write-through-bind failed for op',
          op.id,
          err,
        );
      }
    }
  });
}

// Wipes every row from a wrapped collection's *synced cache* without
// triggering its onDelete handler (which would re-enqueue server deletes).
// Used by clearAll. The next refetch repopulates from the server.
export function clearCollectionCache(collection: any) {
  const utils = collection.utils ?? {};
  if (!utils.writeBatch || !utils.writeDelete) return;
  const keys: Array<unknown> = [];
  for (const [key] of collection.entries()) keys.push(key);
  utils.writeBatch(() => {
    for (const key of keys) utils.writeDelete(key);
  });
}

export type { QueueOp };
