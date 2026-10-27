import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const TEST_DB = process.env.TEST_DB || 'prontuario_test';
export const TEST_DATABASE_URL = `postgresql://postgres:postgres@localhost:5432/${TEST_DB}`;

export function resetDatabase() {
  execFileSync(`${ROOT}/scripts/db-reset-local.sh`, [TEST_DB], { stdio: 'pipe' });
}

export function connect() {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  return client.connect().then(() => client);
}

export async function one(client, sql, params = []) {
  const { rows } = await client.query(sql, params);
  return rows[0];
}

export async function createStaff(client, { name, role, agendaName = null }) {
  const user = await one(client, `insert into auth.users (email) values ($1) returning id`, [
    `${name.toLowerCase().replace(/\W+/g, '.')}@clinica.test`,
  ]);
  await client.query(
    `insert into staff (id, full_name, role, agenda_id)
     values ($1, $2, $3, (select id from agendas where name = $4))`,
    [user.id, name, role, agendaName],
  );
  return user.id;
}

// Runs fn inside a committed transaction as a logged-in Supabase user, so
// RLS and the commit-time reminder recalculation both apply.
export async function asUser(client, userId, fn) {
  await client.query('begin');
  try {
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
    await client.query('set local role authenticated');
    const result = await fn();
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

export async function agendaId(client, name) {
  return (await one(client, `select id from agendas where name = $1`, [name])).id;
}

export async function createPatient(client, fields = {}) {
  const row = await one(
    client,
    `insert into patients (full_name, phone, birth_date, allow_messages)
     values ($1, $2, $3, $4) returning id`,
    [
      fields.name || 'Paciente Teste',
      'phone' in fields ? fields.phone : '(31) 99999-0000',
      fields.birthDate || null,
      fields.allowMessages ?? true,
    ],
  );
  return row.id;
}

// A weekday at least `daysAhead` days from now, as 'YYYY-MM-DD' in clinic time.
export async function futureWeekday(client, weekday = 1, daysAhead = 7) {
  const row = await one(
    client,
    `select d::date::text as day
     from generate_series(clinic_today() + $2::int, clinic_today() + $2::int + 7, interval '1 day') d
     where extract(dow from d) = $1
     limit 1`,
    [weekday, daysAhead],
  );
  return row.day;
}

export async function localTs(client, day, time) {
  return (await one(client, `select local_timestamp($1::date, $2::time) as ts`, [day, time])).ts;
}

export async function expectDbError(promise, code) {
  try {
    await promise;
  } catch (error) {
    if (!error.message.includes(code)) {
      throw new Error(`Expected error "${code}" but got "${error.message}"`);
    }
    return;
  }
  throw new Error(`Expected error "${code}" but the query succeeded`);
}
