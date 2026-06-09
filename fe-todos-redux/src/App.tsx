import { Providers } from './store/Provider';
import { TodoList } from './components/TodoList';
import './index.css';

export function App() {
  return (
    <Providers>
      <div className="max-w-7xl mx-auto p-8 text-center">
        <h1 className="text-5xl font-bold my-4 leading-tight">
          Todos with Redux + TanStack Query
        </h1>
        <p className="mb-4 text-gray-400">
          Powered by Bun + React + Redux Toolkit + TanStack Query + GraphQL
        </p>
        <TodoList />
      </div>
    </Providers>
  );
}

export default App;
