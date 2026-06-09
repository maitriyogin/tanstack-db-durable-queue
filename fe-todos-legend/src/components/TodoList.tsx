import { useState } from 'react';
import { useSelector } from '@legendapp/state/react';
import { state$ } from '../store/state';
import { useTodosQuery } from '../store/useTodosQuery';
import { mutationQueue } from '../store/queue';
import {
  addTodo,
  aliasFor,
  computeQuarantineByRowId,
  computeQueueDepth,
  computeTodos,
  deleteTodo,
  updateTodo,
} from '../store/todosClient';
import type { Todo } from '../store/types';

// Reads the optimistic overlay + queue depth + status + quarantine map.
// Each useSelector callback re-runs when any observable .get() inside it
// changes — that's how Legend State drives re-renders.
//
// (`useSelector` is the v3 hook in @legendapp/state/react — `useValue`
// the docs reference is also exported but `useSelector` is the lower-
// level primitive both names eventually land on.)
export function TodoList() {
  // Drives the TQ effect that hydrates state$.todos.byId.
  useTodosQuery();

  const todos = useSelector(() => computeTodos());
  const status = useSelector(() => state$.todos.status.get());
  const error = useSelector(() => state$.todos.error.get());
  const queueDepth = useSelector(() => computeQueueDepth());
  const quarantineByRowId = useSelector(() => computeQuarantineByRowId());
  // Box #4: aliases per row (parent-resolved so the React `key=` prop
  // can use it, preventing unmounts on temp→server flips).
  const aliases = useSelector(() => todos.map((t) => aliasFor(t.id)));

  const [name, setName] = useState('');

  function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    void addTodo(mutationQueue, {
      name: name.trim(),
      description: '',
      status: 'PENDING',
    }).promise.catch((err) => console.warn('addTodo failed:', err));
    setName('');
  }

  function onToggle(todo: Todo) {
    const next = todo.status === 'PENDING' ? 'COMPLETED' : 'PENDING';
    void updateTodo(mutationQueue, todo.id, { status: next }, todo).catch((err) =>
      console.warn('updateTodo failed:', err),
    );
  }

  function onDelete(todo: Todo) {
    void deleteTodo(mutationQueue, todo.id, todo).catch((err) =>
      console.warn('deleteTodo failed:', err),
    );
  }

  return (
    <div className="text-left max-w-2xl mx-auto mt-8">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-2xl font-semibold">Todos</h2>
        <span className="text-sm text-gray-400">
          {status === 'loading' ? 'loading…' : `queue: ${queueDepth}`}
        </span>
      </div>

      {error && (
        <p className="bg-red-900/40 border border-red-700 p-2 rounded mb-3 text-sm">
          {error}
        </p>
      )}

      <form onSubmit={onAdd} className="flex gap-2 mb-4">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New todo…"
          className="flex-1 bg-[#1a1a1a] border border-gray-700 rounded px-3 py-2"
        />
        <button
          type="submit"
          className="bg-blue-700 hover:bg-blue-600 px-4 py-2 rounded"
        >
          Add
        </button>
      </form>

      <ul className="space-y-2">
        {todos.map((todo, i) => {
          const failed = quarantineByRowId.get(todo.id);
          return (
            <li
              key={aliases[i]}
              className={
                failed
                  ? 'bg-[#1a1a1a] border border-red-700 rounded'
                  : 'bg-[#1a1a1a] border border-gray-800 rounded'
              }
            >
              <div className="flex items-center gap-3 px-3 py-2">
                <input
                  type="checkbox"
                  checked={todo.status === 'COMPLETED'}
                  onChange={() => onToggle(todo)}
                />
                <span
                  className={
                    todo.status === 'COMPLETED'
                      ? 'flex-1 line-through text-gray-500'
                      : 'flex-1'
                  }
                >
                  {todo.name}
                  {todo.id.startsWith('temp_') && !failed && (
                    <span className="text-xs text-yellow-500 ml-2">(pending)</span>
                  )}
                </span>
                <button
                  onClick={() => onDelete(todo)}
                  className="text-red-400 hover:text-red-300 text-sm"
                >
                  ✕
                </button>
              </div>
              {failed && (
                <div className="bg-red-950/50 px-3 py-2 border-t border-red-800 flex items-center gap-3">
                  <span className="flex-1 text-sm text-red-200">
                    ⚠ {failed.quarantineError ?? 'Failed'}
                  </span>
                  <button
                    onClick={() =>
                      mutationQueue.retryCascade(failed.correlationKey)
                    }
                    className="text-xs bg-red-800 hover:bg-red-700 px-2 py-1 rounded"
                  >
                    Retry
                  </button>
                  <button
                    onClick={() =>
                      mutationQueue.discardCascade(failed.correlationKey)
                    }
                    className="text-xs bg-gray-700 hover:bg-gray-600 px-2 py-1 rounded"
                  >
                    Discard
                  </button>
                </div>
              )}
            </li>
          );
        })}
        {todos.length === 0 && status !== 'loading' && (
          <li className="text-gray-500 text-center py-6">No todos yet.</li>
        )}
      </ul>
    </div>
  );
}
