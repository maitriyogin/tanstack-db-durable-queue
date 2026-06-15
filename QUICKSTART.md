# Quick start

Get the repo running end-to-end on a fresh machine: BFF + at least one frontend, exercising the durable mutation queue against real GraphQL.

## What's in the repo

```
tanstack-db-durable-queue/
├── bff-todos/          NestJS GraphQL server, SQLite via Prisma. Port 4010.
├── fe-todos/           Frontend #1 — TanStack DB + TanStack Query. Port 3000.
├── fe-todos-redux/     Frontend #2 — Redux Toolkit + RTK Query.   Port 3000.
├── fe-todos-legend/    Frontend #3 — Legend State + TanStack Query.
├── fe-todos-expo/      Frontend #4 — React Native via Expo + Legend State.
├── e2e/                Playwright tests.
└── data-layer-scenarios.md   The shared spec every frontend implements.
```

Each frontend is an independent implementation of the same requirements list (`data-layer-scenarios.md`) — pick one, or run several side by side against the same BFF.

## Prerequisites

- **Bun ≥ 1.3** (`brew install oven-sh/bun/bun` or [bun.sh](https://bun.sh)).
- **Node 20+** is only required for tooling that hasn't moved to Bun yet.
- Nothing else — Bun handles the SQLite native bindings, the dev server, the bundler, and the test runner.

```sh
bun --version          # should print 1.3.x or newer
```

## Install

From the repo root:

```sh
bun install
```

This installs every workspace (`bff-todos`, `fe-todos`, `fe-todos-redux`, `fe-todos-legend`, `fe-todos-expo`).

## Boot the BFF

```sh
bun run dev:bff
```

What this does:

1. Generates the Prisma client into `bff-todos/node_modules/.prisma/client`.
2. Runs pending migrations against `bff-todos/prisma/dev.db` (SQLite, file-backed).
3. Starts NestJS + Apollo at `http://localhost:4010/graphql`.
4. Writes the SDL to `bff-todos/src/schema.gql` on every code-first resolver compile.

Sanity check:

```sh
curl -s http://localhost:4010/graphql \
  -H 'content-type: application/json' \
  -d '{"query":"query { todos { id name status } }"}' | jq
```

## Boot a frontend

Pick one of the three. Each runs on **`http://localhost:3000`**, so don't run two at once.

### TanStack DB + Query

```sh
bun run dev:fe
```

Mutations land in a SQLite table inside the browser (OPFS). Reads ride live queries.

### Redux + RTK Query

```sh
bun run dev:fe-redux
```

Mutations land in a redux-persist-backed slice (localStorage). RTK Query owns the cache.

### Legend State + Query

```sh
bun run dev:fe-legend
```

Same shape as Redux, but on Legend State observables.

### Run BFF + frontend together

```sh
bun run dev          # boots bff and fe-todos in parallel via concurrently
```

Adapt by editing `package.json`'s `dev` script if you want a different pair.

## What to do once it's running

Open `http://localhost:3000`. You should see a Todos panel and a Shopping Lists panel. The interesting paths:

| Try this | What you should see |
|---|---|
| Add a todo | Row appears instantly. Network tab: `POST /graphql` with `X-Client-Op-Id` header. Op disappears from queue on ack. |
| Toggle a todo's status while throttling network to "Offline" | Optimistic toggle. Op accumulates in the queue (visible in Redux DevTools or `mutationQueue.logSnapshot()` in the JS console). Comes back online → drains. |
| Type a name containing **`XXX`** and create | BFF rejects with `ForbiddenException`. Op quarantines. Red `Failed` band appears under the row with **Retry** / **Discard**. |
| Hard-reload mid-mutation | Op survives reload. `recoveredFromCrash: true` flag flips on the persisted row; runner picks it up after the cold-boot sweep. |
| Add a shopping list to a todo, then add items | List + budget create as separate queued ops. Each item-add fans out into one `addShoppingListItem` HTTP call with a deterministic `X-Client-Op-Id` derived from `${parentOpId}:add:${itemId}`. |
| Repeatedly retry the same op | BFF dedup kicks in: the second attempt with the same `clientOpId` returns the cached response from `ClientOpResult`, no duplicate row. |

## Tests

```sh
bun run test           # fe-todos integration tests (38 test cases, bun test)
bun run test:e2e       # Playwright against fe-todos
```

The Redux and Legend State frontends don't have integration suites yet — verify them manually against a running BFF via the table above.

## Regenerating GraphQL types (Redux frontend only)

```sh
bun run --cwd fe-todos-redux codegen
```

Reads the SDL at `bff-todos/src/schema.gql` and regenerates `fe-todos-redux/src/api/api.generated.ts`. Run this after any BFF schema change.

## Reset state

| What you want | How |
|---|---|
| Wipe the local browser store (queue + caches) | Click **Clear local data** in the UI. Server is untouched. |
| Drop the BFF database | `rm bff-todos/prisma/dev.db` then re-run `bun run dev:bff`. |
| Force a clean install | `rm -rf node_modules bun.lock && bun install`. |

## Where to read next

- **`data-layer-scenarios.md`** — the canonical requirements list. Every frontend implements this.
- **`solutions.md`** — annotated walkthrough of how `fe-todos` (TanStack DB) covers each requirement.
- **`README.md`** — task-by-task tour of `fe-todos`.
- **`fe-todos-redux/src/queue/runner.ts`** — the Redux-side equivalent of TanStack DB's `mutationQueue.ts`. Reads the cleanest as a self-contained drain loop.
- **`fe-todos-redux/src/queue/durableEndpoint.ts`** — the wrapper that ties RTK Query optimistic patches to the durable queue.

## Common gotchas

**Port 3000 already in use.** Another frontend is running. Stop it before booting a different one.

**`storage2.getItem is not a function`.** Bun + redux-persist CJS interop bug. Fixed in `fe-todos-redux` via an inline `localStorage` adapter — if you start a new redux frontend, write your own adapter rather than `import storage from 'redux-persist/lib/storage'`.

**OPFS errors in the TanStack DB frontend.** Open in a clean browser profile. The `index.html` has a Worker shim that rewrites the OPFS package's cross-origin worker URL to a same-origin `/_opfs-assets/` route; reloading after a code change usually fixes transient cases.

**`ClientOpResult` table missing on the BFF.** Run `bun run --cwd bff-todos prisma migrate deploy` to apply the idempotency migration.
