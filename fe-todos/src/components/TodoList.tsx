import { useState } from 'react';
import { useLiveQuery } from '@tanstack/react-db';
import {
  todosCollection,
  todoAuditsCollection,
  addTodo,
  updateTodo,
  deleteTodo,
  clearAll,
} from '../db/client';
import { mutationQueue } from '../db/persistence';
import { useQuarantineFor } from '../db/useQuarantine';
import { TodoShoppingPanel } from './TodoShoppingPanel';
import type { CreateTodoInput, TodoAudit } from '../db/types';

export function TodoList() {
  const [newTodoName, setNewTodoName] = useState('');

  const { data: todos, isLoading } = useLiveQuery((q) =>
    q.from({ todo: todosCollection })
  );

  // Audit counts derived from the audits collection. Each row that exists
  // (synced server row OR queued/quarantined optimistic row) contributes
  // one to its todo's count, so the badge updates instantly on offline
  // edits and reconciles on reconnect.
  const { data: audits } = useLiveQuery((q) =>
    q.from({ audit: todoAuditsCollection })
  );

  const countByTodoId = new Map<string, number>();
  for (const a of (audits as Array<TodoAudit> | undefined) ?? []) {
    countByTodoId.set(a.todoId, (countByTodoId.get(a.todoId) ?? 0) + 1);
  }

  // Quarantined todo ops, keyed by the optimistic row id (parent op's `key`)
  // for fast per-row lookup. Live-updated via subscribeQuarantine.
  const quarantined = useQuarantineFor('todos');
  const quarantineByRowId = new Map(
    quarantined
      .filter((op) => op.quarantineReason === 'parent')
      .map((op) => [op.key, op]),
  );

  const handleAddTodo = async () => {
    const name = newTodoName.trim();
    if (!name) return;

    const input: CreateTodoInput = {
      name,
      status: 'pending',
    };

    try {
      await addTodo(input);
      setNewTodoName('');
    } catch (error) {
      console.error('Failed to add todo:', error);
    }
  };

  const handleToggleStatus = (todoId: string, currentStatus: string) => {
    const newStatus = currentStatus === 'completed' ? 'pending' : 'completed';
    updateTodo(todoId, (draft) => {
      draft.status = newStatus;
    });
  };

  const handleDelete = (todoId: string) => {
    deleteTodo(todoId);
  };

  // Only show the loading state when we have nothing to render. If the
  // synced SQLite cache already has rows, render them — useful when the
  // first network query hasn't returned yet (cold start, slow link, or
  // offline reload), so cached data stays visible instead of being hidden
  // behind a spinner that never resolves.
  if (isLoading && (!todos || todos.length === 0)) {
    return (
      <div className="mt-8 mx-auto w-full max-w-2xl text-center">
        <p className="text-gray-400">Loading todos...</p>
      </div>
    );
  }
  return (
    <div className="mt-8 mx-auto w-full max-w-2xl">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-2xl font-bold">Todos</h2>
        <button
          onClick={async () => {
            if (!confirm('Wipe all local data? Server data is unchanged.')) return;
            try {
              await clearAll();
            } catch (err) {
              console.error('clearAll failed:', err);
            }
          }}
          className="text-xs bg-red-500/10 hover:bg-red-500/20 text-red-300 border border-red-500/30 px-3 py-1 rounded transition-colors"
          title="Wipes the local SQLite cache, durable mutation queue, quarantine, and id bindings. Refetches from the server."
        >
          Clear local data
        </button>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleAddTodo();
        }}
        className="flex gap-2 mb-4"
      >
        <input
          type="text"
          value={newTodoName}
          onChange={(e) => setNewTodoName(e.target.value)}
          placeholder="What needs to be done?"
          className="flex-1 bg-[#1a1a1a] border-2 border-[#fbf0df] rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-[#f3d5a3]"
        />
        <button
          type="submit"
          disabled={!newTodoName.trim()}
          className="bg-[#fbf0df] text-[#1a1a1a] px-4 py-2 rounded-lg font-bold hover:bg-[#f3d5a3] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Add Todo
        </button>
      </form>

      {!todos || todos.length === 0 ? (
        <p className="text-gray-400 text-center py-8">No todos yet. Add one to get started!</p>
      ) : (
        <div className="space-y-2">
          {todos.map((todo) => {
            const failedOp = quarantineByRowId.get(todo?.id);
            return (
              <div
                key={todo?.id}
                className={`bg-[#1a1a1a] rounded-lg p-4 flex items-start justify-between border-2 ${
                  failedOp
                    ? 'border-red-500/60'
                    : 'border-[#fbf0df]'
                }`}
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="font-bold text-lg">{todo?.name}</h3>
                    <span
                      title="Change count"
                      className="inline-flex items-center justify-center min-w-[1.5rem] px-2 py-0.5 rounded-full text-xs bg-[#fbf0df]/10 text-[#fbf0df] border border-[#fbf0df]/30"
                    >
                      {countByTodoId.get(todo?.id) ?? 0}
                    </span>
                  </div>
                  <p className="text-gray-400">{todo?.description}</p>
                  <span
                    className={`inline-block mt-2 px-2 py-1 rounded text-sm ${
                      todo?.status === 'completed'
                        ? 'bg-green-500/20 text-green-400'
                        : 'bg-yellow-500/20 text-yellow-400'
                    }`}
                  >
                    {todo?.status}
                  </span>

                  {failedOp && (
                    <div className="mt-3 px-3 py-2 rounded bg-red-500/10 border border-red-500/30 text-sm">
                      <div className="flex items-center gap-2 text-red-300 font-semibold">
                        <span aria-hidden>⚠️</span>
                        <span>Failed</span>
                      </div>
                      <div className="text-red-200/80 mt-1 break-words">
                        {failedOp.quarantineError ?? 'unknown error'}
                      </div>
                      <div className="flex gap-2 mt-2">
                        <button
                          onClick={() =>
                            mutationQueue.retryCascade(failedOp.correlationKey)
                          }
                          className="bg-red-500/30 hover:bg-red-500/50 text-red-100 px-3 py-1 rounded text-sm transition-colors"
                        >
                          Retry
                        </button>
                        <button
                          onClick={() =>
                            mutationQueue.discardCascade(failedOp.correlationKey)
                          }
                          className="bg-transparent hover:bg-red-500/20 text-red-200 border border-red-500/40 px-3 py-1 rounded text-sm transition-colors"
                        >
                          Discard
                        </button>
                      </div>
                    </div>
                  )}

                  <TodoShoppingPanel todoId={todo?.id} />
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={() => handleToggleStatus(todo?.id, todo?.status)}
                    className="bg-blue-500 hover:bg-blue-600 text-white px-3 py-1 rounded transition-colors"
                  >
                    {todo?.status === 'completed' ? 'Reopen' : 'Complete'}
                  </button>
                  <button
                    onClick={() => handleDelete(todo?.id)}
                    className="bg-red-500 hover:bg-red-600 text-white px-3 py-1 rounded transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
