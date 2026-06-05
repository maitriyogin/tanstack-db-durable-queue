/**
 * This file is the entry point for the React app, it sets up the root
 * element and renders the App component to the DOM.
 *
 * It is included in `src/index.html`.
 *
 * NOTE: The Worker constructor shim that redirects the OPFS persistence
 * package's `file://` worker URL to our same-origin /_opfs-assets/ route
 * lives in `index.html` as a plain <script> *before* this module. It must
 * run before any module imports because `persistence.ts` does a top-level
 * `await openBrowserWASQLiteOPFSDatabase(...)`, which spawns the worker
 * during module evaluation.
 */

import { createRoot } from "react-dom/client";
import { App } from "./App";

function start() {
  const root = createRoot(document.getElementById("root")!);
  root.render(<App />);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}
