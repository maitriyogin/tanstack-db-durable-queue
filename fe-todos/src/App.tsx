import { Suspense, lazy, use } from "react";
import { TodosDBProvider } from "./db/provider";
import { dbReady } from "./db/persistence";
import "./index.css";

import logo from "./logo.svg";
import reactLogo from "./react.svg";

// Components that touch the durable-queue collections are lazy-imported so
// their top-level `createCollection(durableQueueCollectionOptions(...))`
// statements only evaluate *after* persistence has finished initializing.
// Without this gate, `client.ts` and `shoppingListClient.ts` would race the
// async `openBrowserWASQLiteOPFSDatabase(...)` call in persistence.ts and
// occasionally read `null` for `persistence` / `mutationQueue`.
const TodoList = lazy(() =>
  import("./components/TodoList").then((m) => ({ default: m.TodoList })),
);
const ShoppingList = lazy(() =>
  import("./components/ShoppingList").then((m) => ({ default: m.ShoppingList })),
);

function DBLoading() {
  return (
    <p className="text-gray-400 text-center mt-8">Initializing local database…</p>
  );
}

function AppShell() {
  // Suspends until persistence + mutationQueue are constructed.
  use(dbReady);
  return (
    <>
      <TodoList />
      <ShoppingList />
    </>
  );
}

export function App() {
  return (
    <TodosDBProvider>
      <div className="max-w-7xl mx-auto p-8 text-center relative z-10">
        <div className="flex justify-center items-center gap-8 mb-8">
          <img
            src={logo}
            alt="Bun Logo"
            className="h-24 p-6 transition-all duration-300 hover:drop-shadow-[0_0_2em_#646cffaa] scale-120"
          />
          <img
            src={reactLogo}
            alt="React Logo"
            className="h-24 p-6 transition-all duration-300 hover:drop-shadow-[0_0_2em_#61dafbaa] animate-[spin_20s_linear_infinite]"
          />
        </div>

        <h1 className="text-5xl font-bold my-4 leading-tight">Todos with TanStack DB</h1>
        <p className="mb-4">
          Powered by <span className="font-bold">Bun + React + TanStack DB + GraphQL</span>
        </p>

        <Suspense fallback={<DBLoading />}>
          <AppShell />
        </Suspense>
      </div>
    </TodosDBProvider>
  );
}

export default App;