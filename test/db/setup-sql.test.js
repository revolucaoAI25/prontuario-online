import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// supabase/setup.sql is what gets pasted into the Supabase SQL Editor.
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DB = 'prontuario_setup_test';
const env = { ...process.env, PGHOST: process.env.PGHOST || 'localhost', PGUSER: 'postgres', PGPASSWORD: process.env.PGPASSWORD || 'postgres' };
const psql = (args, db = DB) => execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-X', '-d', db, ...args], { env, stdio: 'pipe' }).toString();
const run = (file) => psql(['-f', `${ROOT}/${file}`]);

test('setup.sql is up to date with the migrations and the seed', () => {
  execFileSync('node', [`${ROOT}/scripts/build-setup-sql.mjs`, '--check'], { stdio: 'pipe' });
});

test('setup.sql installs over a half-finished attempt, can be re-run, and never wipes patients', () => {
  psql(['-c', `drop database if exists ${DB} with (force)`], 'postgres');
  psql(['-c', `create database ${DB}`], 'postgres');
  run('supabase/tests/local_supabase_shim.sql');
  // what an earlier attempt may have left: the first migration applied
  run('supabase/migrations/20261027000001_base.sql');

  run('supabase/setup.sql');
  run('supabase/setup.sql');
  assert.equal(psql(['-Atc', 'select count(*) from agendas']).trim(), '4');
  assert.equal(psql(['-Atc', `select phone_key('+55 (31) 98765-4321')`]).trim(), '3187654321');

  psql(['-c', `insert into patients (full_name) values ('Paciente Real')`]);
  assert.throws(() => run('supabase/setup.sql'), /já tem pacientes/);
  assert.equal(psql(['-Atc', 'select count(*) from patients']).trim(), '1');
  psql(['-c', `drop database ${DB} with (force)`], 'postgres');
});
