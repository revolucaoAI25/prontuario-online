// Local stand-in for Vercel's /api routing: /api/<dir>/<segment> is served by
// api/<dir>/[param].js (or api/<dir>/<segment>.js) with req.query filled in.
import http from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const API_DIR = fileURLToPath(new URL('../api', import.meta.url));

function resolveRoute(pathname) {
  const parts = pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  if (parts.length === 0) return null;
  const dir = path.join(API_DIR, ...parts.slice(0, -1));
  const last = parts[parts.length - 1];
  const direct = path.join(dir, `${last}.js`);
  if (existsSync(direct)) return { file: direct, query: {} };
  if (!existsSync(dir)) return null;
  const dynamic = readdirSync(dir).find((f) => /^\[\w+\]\.js$/.test(f));
  if (!dynamic) return null;
  return { file: path.join(dir, dynamic), query: { [dynamic.slice(1, -4)]: last } };
}

export function createDevServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = resolveRoute(url.pathname);
    if (!route) {
      res.statusCode = 404;
      return res.end('Not found');
    }
    req.query = { ...Object.fromEntries(url.searchParams), ...route.query };
    const { default: handler } = await import(pathToFileURL(route.file).href);
    return handler(req, res);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.API_PORT || 3001);
  createDevServer().listen(port, () => console.log(`API em http://localhost:${port}/api`));
}
