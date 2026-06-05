# TanStack DB Client Setup

This directory contains the TanStack DB client setup powered by TanStack Query for automatic GraphQL syncing.

## Structure

- **types.ts** - TypeScript interfaces matching the GraphQL schema
- **graphql.ts** - GraphQL query and mutation functions
- **queryClient.ts** - TanStack Query client instance
- **client.ts** - TanStack DB collection with Query integration
- **provider.tsx** - QueryClientProvider wrapper
- **index.ts** - Public API exports

## Features

### TanStack Query + TanStack DB Integration
The `todosCollection` uses **`queryCollectionOptions`** from `@tanstack/query-db-collection` which provides:
- **Automatic syncing** with GraphQL API via TanStack Query
- **Query invalidation** and automatic refetching
- **Optimistic updates** with automatic rollback on error
- **Built-in caching** and stale-time management
- **Error handling** and retry logic from TanStack Query

No manual sync logic needed - TanStack Query handles it all!

### Live Queries
Use `useLiveQuery` hook to subscribe to the collection directly:

```tsx
// Subscribe to the entire collection
const { data: todos, isLoading } = useLiveQuery(todosCollection);

// Or use query builder for filtering
const { data: todos } = useLiveQuery((q) =>
  q.from({ todo: todosCollection })
    .where(({ todo }) => eq(todo.status, 'pending'))
    .orderBy(({ todo }) => todo.createdAt)
);
```

### Optimistic Mutations
Updates happen instantly in the UI, then sync with the server:

```tsx
// Update - UI updates immediately, then calls GraphQL mutation
todosCollection.update(todoId, (draft) => {
  draft.status = 'completed';
});

// Delete - also optimistic
todosCollection.delete(todoId);

// Insert - via helper function
addTodo({ name: 'New todo', description: 'Description', status: 'pending' });
```

### Helper Functions

- `addTodo(input)` - Create a new todo via GraphQL, then add to collection

## Usage Example

```tsx
import { TodosDBProvider } from './db/provider';
import { useLiveQuery } from '@tanstack/react-db';
import { todosCollection, addTodo } from './db/client';

function App() {
  return (
    <TodosDBProvider>
      <TodoList />
    </TodosDBProvider>
  );
}

function TodoList() {
  // Subscribe to the collection - it automatically syncs on first access!
  const { data: todos, isLoading } = useLiveQuery(todosCollection);

  if (isLoading) return <div>Loading...</div>;

  return (
    <div>
      {todos?.map((todo) => (
        <div key={todo.id}>{todo.name}</div>
      ))}
    </div>
  );
}
```

## Benefits

1. **Sub-millisecond queries** - Local queries are extremely fast
2. **Instant UI updates** - Optimistic mutations make the app feel instant
3. **Automatic reactivity** - Components re-render only when their data changes
4. **Normalized storage** - No data duplication, single source of truth
5. **Type safety** - Full TypeScript support throughout
6. **Error handling** - Failed mutations are automatically rolled back

## GraphQL API

The client connects to: `http://localhost:4010/graphql`

Make sure your backend server is running before using the client.

## How It Works

1. **TanStack Query Sync**: The collection uses a `queryFn` that fetches from GraphQL - TanStack Query manages caching, refetching, and background updates
2. **Auto-Refetch**: The collection automatically refetches when needed (configurable via `staleTime`, `refetchInterval`)
3. **Optimistic Mutations**: Call collection methods (`insert`, `update`, `delete`) for instant UI updates
4. **Server Persistence**: The `onInsert`, `onUpdate`, and `onDelete` handlers persist to GraphQL
5. **Automatic Rollback**: If a mutation fails, TanStack DB automatically rolls back the optimistic change

```typescript
// Under the hood
queryCollectionOptions({
  queryKey: ['todos'],           // TanStack Query cache key
  queryFn: fetchTodos,            // Automatic data fetching
  queryClient,                    // Shared Query client
  onInsert: createOnServer,       // Persist inserts
  onUpdate: updateOnServer,       // Persist updates
  onDelete: deleteOnServer,       // Persist deletes
})
```
