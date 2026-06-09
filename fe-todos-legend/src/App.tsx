import { QueryClientProvider } from '@tanstack/react-query';
import { TodoList } from './components/TodoList';
import { queryClient } from './store/queryClient';
// Side-effect import: hydrates state$ from localStorage and wires the
// queue runner. Must run before TodoList renders (it does, since
// TodoList imports from ./store/queue transitively).
import './store/queue';
import './index.css';

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <div className="max-w-7xl mx-auto p-8 text-center">
        <h1 className="text-5xl font-bold my-4 leading-tight">
          Todos with Legend State + TanStack Query
        </h1>
        <p className="mb-4 text-gray-400">
          Powered by Bun + React + Legend State + TanStack Query + GraphQL
        </p>
        <TodoList />
      </div>
    </QueryClientProvider>
  );
}

export default App;
