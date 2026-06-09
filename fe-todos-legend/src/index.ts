import { serve } from 'bun';
import index from './index.html';

const PORT = Number(process.env.PORT ?? 3003);

const server = serve({
  port: PORT,
  routes: { '/*': index },
  development: process.env.NODE_ENV !== 'production' && {
    hmr: true,
    console: true,
  },
});

console.log(`🚀 fe-todos-legend running at ${server.url}`);
