#!/usr/bin/env bun
import plugin from 'bun-plugin-tailwind';
import { existsSync } from 'fs';
import { rm } from 'fs/promises';
import path from 'path';

const outdir = path.join(process.cwd(), 'dist');
if (existsSync(outdir)) await rm(outdir, { recursive: true, force: true });

const entrypoints = [...new Bun.Glob('**.html').scanSync('src')]
  .map((a) => path.resolve('src', a))
  .filter((dir) => !dir.includes('node_modules'));

const result = await Bun.build({
  entrypoints,
  outdir,
  plugins: [plugin],
  minify: true,
  target: 'browser',
  sourcemap: 'linked',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
});

console.table(
  result.outputs.map((o) => ({
    File: path.relative(process.cwd(), o.path),
    Type: o.kind,
    Size: o.size,
  })),
);
