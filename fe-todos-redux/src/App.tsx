import { StoreProvider } from "./store/StoreProvider";
import { TodoList } from "./components/TodoList";
import { ShoppingList } from "./components/ShoppingList";
import "./index.css";

import logo from "./logo.svg";
import reactLogo from "./react.svg";

export function App() {
  return (
    <StoreProvider>
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

        <h1 className="text-5xl font-bold my-4 leading-tight">Todos with Redux + RTK Query</h1>
        <p className="mb-4">
          Powered by <span className="font-bold">Bun + React + Redux Toolkit + GraphQL</span>
        </p>

        <TodoList />
        <ShoppingList />
      </div>
    </StoreProvider>
  );
}

export default App;