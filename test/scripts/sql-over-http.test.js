import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { inlineParams, literal, SqlClient } from '../../scripts/lib/sql-over-http.mjs';

// The HTTPS path sends SQL with the parameters written in; it must mean
// exactly what the same query with bind parameters means.
const url = `postgresql://postgres:postgres@localhost:5432/${process.env.TEST_DB || 'prontuario_test'}`;
let db;
before(async () => { db = new pg.Client({ connectionString: url }); await db.connect(); });
after(() => db.end());

const tricky = [
  "O'Brien \\ \"aspas\" $q0$ $$ fim",
  'linha 1\nlinha 2\ttab',
  'Ação, ÇÃO, emoji 😊',
  '',
];

test('strings, numbers, booleans, null, dates, arrays and json round-trip exactly', async () => {
  const params = [tricky[0], tricky[1], tricky[2], tricky[3], 42, -3.5, true, null, new Date('2026-10-27T12:34:56.789Z'), [1, 2, 3], [], JSON.stringify([{ nome: "D'Ávila", n: 1 }])];
  const sql = `select $1::text a, $2::text b, $3::text c, $4::text d, $5::int e, $6::numeric f, $7::bool g, $8::text h,
                      $9::timestamptz i, $10::int[] j, $11::int[] k, $12::jsonb l`;
  const expected = (await db.query(sql, params)).rows[0];
  const inlined = (await db.query({ text: inlineParams(sql, params), queryMode: 'simple' })).rows[0];
  assert.deepEqual(inlined, expected);
});

test('$10 is not read as $1 followed by 0, and a missing parameter is an error', () => {
  const params = Array.from({ length: 10 }, (_, i) => i + 1);
  assert.equal(inlineParams('select $1, $10', params), 'select 1, 10');
  assert.throws(() => inlineParams('select $2', [1]), /\$2/);
  assert.equal(literal(undefined), 'NULL');
});

test('transaction statements are skipped; rows come back as from pg', async () => {
  const sent = [];
  const client = new SqlClient(async (sql) => { sent.push(sql); return (await db.query({ text: sql, queryMode: 'simple' })).rows; });
  await client.query('begin');
  const { rows, rowCount } = await client.query('select x from generate_series(1, $1::int) x', [3]);
  await client.query('commit');
  assert.deepEqual(rows.map((r) => r.x), [1, 2, 3]);
  assert.equal(rowCount, 3);
  assert.equal(sent.length, 1);
});
