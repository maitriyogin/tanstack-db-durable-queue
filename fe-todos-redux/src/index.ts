import { serve } from 'bun';
import index from './index.html';

// Sibling FE app to fe-todos. Same BFF, different port (4011 vs 4010 for the
// BFF, 3000 for fe-todos). Lets you run both at once and compare side-by-
// side.
const PORT = Number(process.env.PORT ?? 3001);

const server = serve({
  port: PORT,
  routes: {
    '/*': index,
  },

  development: process.env.NODE_ENV !== 'production' && {
    hmr: true,
    console: true,
  },
});

console.log(`🚀 fe-todos-redux running at ${server.url}`);
