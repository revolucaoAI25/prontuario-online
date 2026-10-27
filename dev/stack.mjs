#!/usr/bin/env node
// Starts a local stand-in for the production stack against a local Postgres:
// PostgREST (:3000) + Supabase emulator (:54321) + the /api functions (:3001).
// Then run `npm run dev` for the web app (Vite proxies /api to :3001).
//
//   POSTGREST_BIN=/path/to/postgrest DATABASE=prontuario node dev/stack.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createEmulator, ANON_KEY, SERVICE_ROLE_KEY, DEV_JWT_SECRET } from './supabase-emulator.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const database = process.env.DATABASE || 'prontuario';
const adminUrl = `postgresql://postgres:postgres@localhost:5432/${database}`;

const postgrest = spawn(process.env.POSTGREST_BIN || 'postgrest', [], {
  stdio: ['ignore', 'inherit', 'inherit'],
  env: {
    ...process.env,
    PGRST_DB_URI: `postgresql://authenticator:authenticator@localhost:5432/${database}`,
    PGRST_DB_SCHEMAS: 'public',
    PGRST_DB_ANON_ROLE: 'anon',
    PGRST_JWT_SECRET: DEV_JWT_SECRET,
    PGRST_SERVER_PORT: '3000',
    PGRST_DB_POOL: '5',
    PGRST_LOG_LEVEL: 'warn',
  },
});

createEmulator({
  databaseUrl: adminUrl,
  postgrestUrl: 'http://localhost:3000',
  storageDir: process.env.STORAGE_DIR || `${ROOT}/.dev-storage`,
}).listen(54321);

Object.assign(process.env, {
  DATABASE_URL: adminUrl,
  CLINIC_API_KEY: process.env.CLINIC_API_KEY || 'dev-api-key',
  CRON_SECRET: process.env.CRON_SECRET || 'dev-cron-secret',
  EVOLUTION_WEBHOOK_SECRET: process.env.EVOLUTION_WEBHOOK_SECRET || 'dev-evolution-secret',
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
});
const { createDevServer } = await import('../server/dev-server.js');
createDevServer().listen(3001);

console.log(`
Supabase (emulado): http://localhost:54321
API:                http://localhost:3001/api   (x-api-key: ${process.env.CLINIC_API_KEY})

Para o app (arquivo .env.local):
VITE_SUPABASE_URL=http://localhost:54321
VITE_SUPABASE_ANON_KEY=${ANON_KEY}
`);

const stop = () => {
  postgrest.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
