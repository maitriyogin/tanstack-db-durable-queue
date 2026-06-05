import { serve } from "bun";
import { resolveSync } from "bun";
import { join, dirname } from "node:path";
import index from "./index.html";

// The OPFS persistence package ships a Web Worker as a separate asset that
// it loads with `new URL("../assets/...", import.meta.url)`. Under Bun's
// dev server the package is served from a file:// URL inside node_modules,
// which the browser refuses to spawn a Worker from due to the same-origin
// rule. Resolve the package's dist directory at boot and serve it from a
// known HTTP path so the worker URL becomes same-origin.
const opfsPkgEntry = resolveSync(
  "@tanstack/browser-db-sqlite-persistence",
  import.meta.dir,
);
const opfsAssetsDir = join(dirname(opfsPkgEntry), "..", "assets");

const server = serve({
  routes: {
    // Serve OPFS worker assets from same-origin so the Worker constructor
    // can load them. The exact filename includes a content hash, so we
    // glob to whatever the package is shipping.
    "/_opfs-assets/:file": (req) => {
      const file = Bun.file(join(opfsAssetsDir, req.params.file));
      return new Response(file, {
        headers: { "Content-Type": "application/javascript" },
      });
    },

    // Serve index.html for all unmatched routes.
    "/*": index,

    "/api/hello": {
      async GET(req) {
        return Response.json({
          message: "Hello, world!",
          method: "GET",
        });
      },
      async PUT(req) {
        return Response.json({
          message: "Hello, world!",
          method: "PUT",
        });
      },
    },

    "/api/hello/:name": async req => {
      const name = req.params.name;
      return Response.json({
        message: `Hello, ${name}!`,
      });
    },
  },

  development: process.env.NODE_ENV !== "production" && {
    // Enable browser hot reloading in development
    hmr: true,

    // Echo console logs from the browser to the server
    console: true,
  },
});

console.log(`🚀 Server running at ${server.url}`);
