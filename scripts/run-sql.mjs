#!/usr/bin/env node
// Runs a SQL file (or -c "query") on the Supabase database over HTTPS, through
// the Management API, and prints the rows. For machines without access to
// the database ports.
//
//   SUPABASE_ACCESS_TOKEN=sbp_... SUPABASE_PROJECT_REF=abcd... \
//     node scripts/run-sql.mjs supabase/migrations/20261027000009_hide_superadmin.sql
//   ... node scripts/run-sql.mjs -c "select count(*) from patients"
import { readFileSync } from 'node:fs';
import { managementApiRunner } from './lib/sql-over-http.mjs';

const token = process.env.SUPABASE_ACCESS_TOKEN;
const projectRef = process.env.SUPABASE_PROJECT_REF;
if (!token || !projectRef) {
  console.error('Defina SUPABASE_ACCESS_TOKEN e SUPABASE_PROJECT_REF.');
  process.exit(1);
}
const args = process.argv.slice(2);
const sql = args[0] === '-c' ? args[1] : readFileSync(args[0], 'utf8');
if (!sql) {
  console.error('Uso: node scripts/run-sql.mjs arquivo.sql | -c "select ..."');
  process.exit(1);
}
const rows = await managementApiRunner({ token, projectRef })(sql);
if (rows.length) console.table(rows);
else console.log('OK');
