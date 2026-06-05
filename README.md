# TanStack DB + Durable Queue

A frontend data layer that makes optimistic mutations feel instant, survive a refresh, and recover from server failures — built on top of TanStack DB and TanStack Query, with SQLite for durability.

The full requirements list lives in [`data-layer-scenarios.md`](./data-layer-scenarios.md). This README walks through each task that built up the solution.

## How it fits together

There's one new piece — `durableQueueCollectionOptions` — that wraps any TanStack DB collection. When you mutate a row, the wrapper:

1. Lets TanStack DB show the change instantly (optimistic state).
2. Drops the mutation onto a **durable queue** (a SQLite table).
3. A background runner picks ops off the queue in order and calls your real server handler.
4. Once the server acks, the optimistic state hands off to the server data.

If the server fails or the user is offline, the op stays in the queue. If the tab crashes, the op is still there on next load. If something fails repeatedly, it goes into a separate **quarantine** table and the UI offers Retry / Discard.

**Key files:**
- `fe-todos/src/db/durableQueueCollection.ts` — the wrapper.
- `fe-todos/src/db/mutationQueue.ts` — the durable queue + runner.
- `fe-todos/src/db/persistence.ts` — SQLite handle shared across collections.
- `fe-todos/src/db/client.ts` — wraps `todosCollection` and exports intent-time helpers.

---

## Task 1 — Set up the wrapper

**What it covers:** foundation for everything below.

Created `durableQueueCollectionOptions(config)`. At this point it's just a pass-through that combines `queryCollectionOptions` (server sync) with `persistedCollectionOptions` (SQLite). The point was to introduce one seam every later task could plug into without rewriting components.

Persistence and queue are passed in as parameters so tests can swap in a Bun-SQLite version.

---

## Task 2 — Instant local apply + a durable queue

**Box:** Immediate local apply + durable ordered queue.

A second SQLite-backed collection called `mutation-queue` stores one row per mutation: `{id, type, key, payload, seq, status, ...}`. The wrapper rewrites your `onInsert`/`onUpdate`/`onDelete` handlers to:

1. Let TanStack DB apply the optimistic change.
2. Insert a row into the queue.
3. Wait until the runner has actually executed the mutation against the server.

The runner drains ops in **FIFO order** using a monotonic `seq` counter (not timestamps — those collide when two mutations happen in the same tick, which a test caught).

---

## Task 3 — Refetch sibling collections after an ack

**Box:** Ack reconciliation + refetch.

The collection's own data refetches automatically once the handler resolves — that's `queryCollectionOptions` doing its job. The gap was sibling collections: previously every consumer had to remember to invalidate `['todoAuditCounts']` themselves.

Added an `invalidates: QueryKey[]` option on the wrapper. After a successful ack, the wrapper invalidates each declared key. Consumers stop having to remember.

---

## Task 4 — Temp IDs that survive a crash

**Box:** Temp ID generation, crash-safe reconciliation, render-key alias.

When you create a row optimistically, you don't have the server's ID yet. So:

1. **Mint a temp ID** like `temp_<uuid>` — recognizable on sight, no side-table needed.
2. **Insert handlers can return `{serverId}`** — the runner detects when the returned ID differs from the temp one and binds them.
3. **Persisted ID-binding store** — a third SQLite collection (`id-bindings`) keeps the temp→server mapping. Crash mid-bind, and it's still there next time.
4. **Rewrite later ops at dispatch time** — if you toggle a row while its create is still in flight, the runner swaps the temp ID for the server ID right before sending.
5. **Render-key alias** — components key React lists off a stable alias so a row doesn't unmount when its ID flips from temp to server.

---

## Task 5 — Failed op rolls back only itself

**Box:** Scoped rollback that preserves concurrent local edits.

**No new code needed.** The architecture from earlier tasks already gives this for free:

- The runner's catch block deletes only the failed op and rejects only its own promise — other queued ops aren't touched.
- TanStack DB creates one transaction per mutation, so rolling back one transaction doesn't affect others.

Tests were added to lock the contract in: a failed op on a row leaves later ops on the same row alone, and an unrelated row never sees the rollback.

---

## Task 6 — One mutation, multiple collections

**Box:** Multi-collection projections that roll back / quarantine atomically.

Some mutations need to write to more than one collection (e.g. toggling a todo also appends an audit log entry). Added a `projections` option:

```ts
projections: {
  audit: {
    apply: (op) => Promise<void>,            // server write
    optimistic?: (op) => () => void,         // optimistic write + rollback thunk
    onError?: 'tolerate' | 'cascade',        // default: tolerate
  }
}
```

Projections run **after** the parent's server write succeeds. Error policies:

- **`tolerate`** (default) — the projection failed, log a warning, parent keeps going.
- **`cascade`** — the projection failed, roll back this projection, all earlier projections in reverse, and the parent. Use this for hard dependencies (e.g. inventory decrement on a sale).

The audit log moved from inline `recordAudit(...)` calls scattered across handlers into a single `projections.audit` declaration.

---

## Task 7 — Mark which ops are safe to retry

**Box:** Per-op `retrySafe` flag honored.

Some mutations are safe to retry (idempotent updates), some aren't (creating a row twice = duplicate row). Added `retrySafe`:

```ts
// Sugar form
retrySafe: { insert: false, update: true, delete: false }

// Or function form
retrySafe: (op) => op.type === 'update'
```

Defaults: only `update` retries. Inserts and deletes need explicit opt-in. After a failure, if the op is retry-safe and below `MAX_ATTEMPTS = 5`, the runner picks it up again. Otherwise it's terminal.

---

## Task 8 — Backoff that survives a reload

**Box:** Persistent exponential backoff with reload-safe schedule.

If the server returns a 5xx, you don't want to hammer it. Added:

1. **`nextAttemptAt`** column on each op — the wall-clock time it becomes eligible. Persisted with the op, so a refresh doesn't reset the wait.
2. **Backoff curve** — `min(2^attempts × 500ms, 30s)`. Configurable.
3. **Wake-up timer** — when there's nothing eligible right now, the runner schedules a single `setTimeout` for the earliest due op and exits. Multiple triggers don't stack — the timer is canceled and re-armed.

Test: open a session, let an op schedule a retry for `+1000ms`, "crash" the DB, reopen 200ms later. The op still waits the remaining 800ms — no premature retry, no reset.

---

## Task 9 — Quarantine after repeated failure

**Box:** Quarantine boundary + cascade grouping by correlation key.

After an op exhausts its retries (or fails non-retryably), it doesn't get deleted — it moves to a `mutation-quarantine` SQLite collection. This keeps it out of the active queue but visible for inspection.

Each op gets a **correlation key** at enqueue time, defaulting to `${collectionId}:${serverId(key)}`. So a "create then toggle then toggle" sequence on the same row shares one key, and toggles after a temp→server bind keep the same key.

When an **insert** quarantines, sibling ops in the same group quarantine alongside it (a toggle is meaningless if its create never landed). For non-insert failures we don't cascade — two unrelated updates on the same server-bound row shouldn't take each other down.

---

## Task 10 — Let the user retry or discard

**Box:** Retry / discard / discard-anchor-requeue-rest recovery actions.

Three new methods on the queue:

```ts
queue.retryCascade(correlationKey)              // requeue the whole group
queue.discardCascade(correlationKey)            // drop the group, undo optimistic
queue.discardAnchorRequeueRest(correlationKey)  // drop the failed parent, retry the children
```

**Important design choice:** when an op quarantines, the parent's transaction is **not** rejected. TanStack DB keeps the optimistic state visible while the transaction is unresolved, so the row stays on screen until the user picks an action. Only the recovery actions actually settle the transaction (retry tries again; discard rejects and rolls back).

---

## Task 11 — Drain on reconnect / auth flip

**Box:** Drain on reconnect + auth flip behind a single mutex.

Three additions:

1. **`queue.triggerDrain()`** — clears any active backoff wait and kicks the runner. The same mutex the wake timer uses applies, so concurrent triggers don't double-dispatch.
2. **Mutex follow-on** — if a trigger fires while a drain is already running, an extra pass is queued so nothing gets stranded.
3. **`attachDrainTriggers({ queue, onAuthFlip? })`** — wires `online` and `focus` browser events to `triggerDrain()`. Auth flips are caller-supplied (no standard event for that).

Refetch-on-reconnect for queries comes from TanStack Query's built-in `refetchOnReconnect`.

---

## Task 12 — Cold-boot sweep

**Box:** Cold-boot sweep + crash-vs-in-flight disambiguation.

A previous tab might have crashed mid-write. On boot we need to figure out which ops are still in flight in *this* session vs left over from a dead one.

1. **`SESSION_ID`** — every queue mints a fresh UUID. Stamped on each op when it goes inflight.
2. **`coldBootSweep()`** runs once at startup and walks every persisted op:
   - **Inflight with a foreign session ID** → demote to pending and mark `recoveredFromCrash: true`. The UI can show "Recovered after crash" instead of "Sending…".
   - **`attempts >= MAX_ATTEMPTS`** → straight to quarantine.
   - **Pending with a future `nextAttemptAt`** → leave alone; the wake timer re-arms.
3. **`recoveredFromCrash` is sticky until next attempt** — cleared when the op next goes inflight, so the UI distinguishes "waiting in this session" from "actively trying."

---

## Coverage complete

All 11 boxes from `data-layer-scenarios.md` are satisfied. **38 integration tests** cover them, all passing under `bun test`.

---

# Follow-ups

These weren't in the original checklist but came up while building things on top of the queue.

## Offline pause

**Bug.** Going offline, mutating a todo, then coming back online sometimes lost the mutation. The op was burning through `MAX_ATTEMPTS` while offline because connectivity errors counted as real failures.

**Fix.** Don't attempt the op at all when offline. Added an `isOnline?: () => boolean` option on the queue (default: `navigator.onLine`). The runner checks at the top of each loop iteration; when false, it pauses without picking. The `online` event triggers a drain, which re-enters the loop.

Also wired `attachDrainTriggers(...)` in `client.ts` (it existed but wasn't called).

## Audits as a first-class collection

**Bug.** Audit count badge stayed stale offline because audits were piggy-backing on the parent todo op's projection — and projections only run when the parent's server call succeeds.

**Fix.** Audits are now their own wrapped collection (`todoAuditsCollection`) with its own queue rows. When you mutate a todo, an audit op enqueues independently — it drains on its own when online returns, even if the parent todo is still pending.

The audit `enqueueAudit(...)` call also moved from inside the parent's server handler to **intent-time helpers** (`addTodo` / `updateTodo` / `deleteTodo`). That way, the audit lands in the queue the moment the user clicks, not after the server replies.

## Quarantine UI

**Why.** Recovery actions worked in the queue but only via DevTools. Users couldn't reach them.

**Solution.**

- `MutationQueue.subscribeQuarantine(listener)` — small subscription API.
- `useQuarantineFor(collectionId)` — `useSyncExternalStore` hook that returns the current quarantined ops.
- In `TodoList.tsx`, rows that match a quarantined op get a red border and a panel below with the error message and **Retry** / **Discard** buttons.

`discardAnchorRequeueRest` isn't surfaced — most failures here are anchor-only with no dependents to requeue.

## BFF "XXX" trigger

To exercise the recovery UX against a real running server, the BFF rejects any todo whose name contains `"XXX"` with a `ForbiddenException`. Let you create `"buy XXX milk"`, watch the queue go through `enqueue → inflight → reject → quarantine`, then click Retry/Discard in the UI.

## Shopping list per todo

A nested feature that exercises the queue against more complex shapes:

- Optional 1:1 link between `Todo` and `ShoppingList` (`todoId String?`).
- `shoppingListsCollection` migrated to use `durableQueueCollectionOptions`.
- New `TodoShoppingPanel` rendered under each todo row with expand/collapse, item add/remove, and quantity.

Outer list IDs use `mintTempId()` so the wrapper handles temp→server binding. Inner item IDs also use temp IDs but don't roundtrip through the binding map — the GraphQL response carries the server item ID and the next refetch reconciles.

## Budget per shopping list

A concrete projection target for testing rollback semantics. Each list has a `Budget` with `total` and `remaining`; each item has a `cost`. Adding an item decrements the budget.

After several iterations, the final shape:

- **Budget is its own BFF module** (`bff-todos/src/budgets/`) — its own DAO, service, resolver. The list's `create` no longer touches Budget.
- **Budget is its own wrapped collection** (`fe-todos/src/db/budgetClient.ts`). `onInsert` POSTs `createBudget`, `onUpdate` POSTs `decrementBudget` or `incrementBudget` depending on the sign of the delta.
- **The shopping list's projection** fires on item-add/remove. It calls `decrementBudgetForShoppingList(...)` (or increment), which is just a normal `collection.update` on the wrapped budgets collection — every budget mutation flows through the same durable queue as everything else.

So when a user adds an item: list update queues, budget decrement queues, both drain in order, both can fail and quarantine independently.

## Cascade-delete linked shopping lists

**Bug.** Deleting a todo left its linked shopping list (and items + budget) orphaned server-side.

**Fix.** Two places:

1. Prisma schema: `ShoppingList.todo` is now a real relation with `onDelete: Cascade`. Deleting a todo cascades to the list, then items, then budget.
2. FE `deleteTodo(todoId)` deletes any linked shopping lists *before* deleting the todo, so the panel disappears immediately rather than waiting for a refetch.

## Post-bind flicker fix

**Bug.** Offline create + delete of the same shopping list briefly showed the list on reconnect, then disappeared. The create's auto-refetch landed the new server-id row in the cache before the queued delete (still keyed under the temp id) drained.

**Fix.** `MutationQueue.subscribeBindings(listener)` + `pendingOpsFor(collectionId, key)`. When a temp→server bind happens, walk the queued ops with that temp ID and project their intent under the bound server ID via `utils.writeDelete` / `utils.writeUpsert` — masking the row in the synced cache before the auto-refetch lands.

## `clearAll` — local-only reset

A "Clear local data" button that:

1. Rejects every pending `awaitOpCompletion` deferred so parent transactions don't hang.
2. Cancels the wake timer.
3. Wipes the queue / quarantine / id-bindings tables.
4. Resets in-memory mirrors.
5. Iterates each wrapped collection's keys and calls `utils.writeDelete` (bypasses `onDelete` so we don't queue server deletes against rows we're forgetting).

**No automatic refetch** — caches stay empty until the next focus / online / mutation. Server data is untouched, so it'll come back via natural triggers. Gated behind a `confirm(...)` dialog.

---

# Status

All 11 boxes from `data-layer-scenarios.md` complete, plus the follow-ups above. **38 integration tests**, all passing under `bun test` (or `bun run test` from the repo root).
