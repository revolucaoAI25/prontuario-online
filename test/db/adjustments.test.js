import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, connect, one, createStaff, asUser, createPatient, agendaId, expectDbError } from '../helpers/db.js';

// The clinic's 04/11 requests: merging duplicate patients, the Financeiro
// password, the Pessoal and Administrativo tabs, per-person mute.
let db;
let admin;
let secretaria;
let simone;

before(async () => {
  resetDatabase();
  db = await connect();
  admin = await createStaff(db, { name: 'Everson', role: 'admin', agendaName: 'Dr. Everson Rezeck' });
  secretaria = await createStaff(db, { name: 'Ana', role: 'secretaria' });
  simone = await createStaff(db, { name: 'Simone', role: 'profissional', agendaName: 'Simone Rezeck' });
});
after(() => db.end());

test('the clinic palette, Saturday until 14h and "Retorno" as the shown name (the API name stays)', async () => {
  const { rows } = await db.query(`select name, color from agendas order by sort_order`);
  assert.deepEqual(rows.map((r) => r.color), ['#6F8FB8', '#E8B86D', '#8CBF9A', '#E58FA9']);
  const saturday = await db.query(`select a.name from agenda_hours h join agendas a on a.id = h.agenda_id where h.weekday = 6 and h.end_time = '14:00' order by 1`);
  assert.deepEqual(saturday.rows.map((r) => r.name), ['Dr. Everson Rezeck', 'Simone Rezeck']);
  const type = await one(db, `select name, display_name from appointment_types where display_name is not null`);
  assert.deepEqual(type, { name: 'Avaliação estética', display_name: 'Retorno' });
});

test('likely duplicates are listed, and merging moves everything to the patient that stays', async () => {
  const keep = await createPatient(db, { name: 'Joana Mendes Silva', phone: '(31) 98111-0000' });
  const drop = await createPatient(db, { name: 'Joana Mendes Silva', phone: '(31) 98222-0000' });
  await db.query(`update patients set legacy_id = 777, cpf = '123.456.789-09', notes = 'Alergia a lidocaína' where id = $1`, [drop]);
  const agenda = await agendaId(db, 'Estética');
  await db.query(`insert into appointments (agenda_id, patient_id, starts_at, ends_at, status) values ($1, $2, now() - interval '30 days', now() - interval '29 days 23 hours', 'chegou')`, [agenda, drop]);
  await db.query(`insert into record_entries (patient_id, content) values ($1, 'Primeira sessão')`, [drop]);
  await db.query(`insert into payments (patient_id, amount, method, status) values ($1, 200, 'pix', 'pago')`, [drop]);

  const pairs = await asUser(db, admin, async () => (await db.query(`select * from duplicate_patient_pairs()`)).rows);
  const pair = pairs.find((p) => [p.patient_a, p.patient_b].includes(keep) && [p.patient_a, p.patient_b].includes(drop));
  assert.equal(pair.motivo, 'Mesmo nome completo');
  await expectDbError(asUser(db, secretaria, () => db.query(`select * from duplicate_patient_pairs()`)), 'acesso_negado');
  await expectDbError(asUser(db, secretaria, () => db.query(`select merge_patients($1, $2)`, [keep, drop])), 'acesso_negado');

  await asUser(db, admin, () => db.query(`select merge_patients($1, $2)`, [keep, drop]));
  const counts = await one(db, `select
      (select count(*)::int from appointments where patient_id = $1) as visits,
      (select count(*)::int from record_entries where patient_id = $1) as entries,
      (select count(*)::int from payments where patient_id = $1) as payments,
      (select count(*)::int from patients where id = $2) as dropped`, [keep, drop]);
  assert.deepEqual(counts, { visits: 1, entries: 1, payments: 1, dropped: 0 });
  const merged = await one(db, `select phone, phone_alt, cpf, notes, legacy_id from patients where id = $1`, [keep]);
  assert.equal(merged.phone, '(31) 98111-0000');
  assert.equal(merged.phone_alt, '(31) 98222-0000');
  assert.equal(merged.cpf, '123.456.789-09');
  assert.equal(merged.notes, 'Alergia a lidocaína');
  assert.equal(merged.legacy_id, 777, 'the FastClinic id now points at the patient that stayed');
  assert.equal((await one(db, `select patient_by_legacy(777) as id`)).id, keep);
});

test('a pair marked as different people stops being suggested', async () => {
  const a = await createPatient(db, { name: 'Pedro Alves Costa', phone: '(31) 98333-0000' });
  const b = await createPatient(db, { name: 'Pedro Alves Costa', phone: '(31) 98444-0000' });
  const [lo, hi] = [a, b].sort();
  const listed = async () => (await asUser(db, admin, async () => (await db.query(`select * from duplicate_patient_pairs()`)).rows))
    .some((p) => p.patient_a === lo && p.patient_b === hi);
  assert.ok(await listed());
  await asUser(db, admin, () => db.query(`insert into patient_not_duplicates (patient_a, patient_b) values ($1, $2)`, [lo, hi]));
  assert.ok(!(await listed()));
});

test('Financeiro password: the admin sets it, the reception checks it, five misses make it wait', async () => {
  assert.equal((await asUser(db, secretaria, () => one(db, `select finance_pin_is_set() as v`))).v, false);
  await expectDbError(asUser(db, secretaria, () => db.query(`select set_finance_pin('1234')`)), 'acesso_negado');
  await expectDbError(asUser(db, admin, () => db.query(`select set_finance_pin('12a4')`)), 'senha_invalida');
  await asUser(db, admin, () => db.query(`select set_finance_pin('4821')`));

  const check = (user, pin) => asUser(db, user, async () => (await one(db, `select check_finance_pin($1) as r`, [pin])).r);
  assert.equal(await check(secretaria, '4821'), 'ok');
  assert.equal(await check(admin, '4821'), 'ok');
  for (let i = 0; i < 5; i++) assert.equal(await check(secretaria, '0000'), 'errada');
  assert.equal(await check(secretaria, '4821'), 'aguarde', 'even the right one waits after five misses');
  await expectDbError(check(simone, '4821'), 'acesso_negado');
  assert.equal((await asUser(db, secretaria, () => db.query(`select * from finance_pin`))).rows.length, 0, 'nobody reads the hash');
});

test('Pessoal is the admin only; Administrativo is admin and reception', async () => {
  const employee = await asUser(db, admin, () => one(db, `insert into employees (full_name, role_title) values ('Kelly', 'Depilação') returning id`));
  await asUser(db, admin, () => db.query(`insert into employee_vacations (employee_id, starts_on, ends_on) values ($1, '2026-07-01', '2026-07-15')`, [employee.id]));
  assert.equal((await asUser(db, secretaria, () => db.query(`select * from employees`))).rows.length, 0);
  assert.equal((await asUser(db, secretaria, () => db.query(`select * from employee_vacations`))).rows.length, 0);

  const task = await asUser(db, secretaria, () => one(db, `insert into admin_tasks (title, remind_at) values ('Manutenção do ar-condicionado', now() + interval '1 day') returning id, created_by`));
  assert.equal(task.created_by, secretaria);
  await asUser(db, secretaria, () => db.query(`insert into admin_notes (title, body) values ('Contador', 'Ligar dia 5')`));
  assert.equal((await asUser(db, admin, () => db.query(`select * from admin_tasks`))).rows.length, 1);
  assert.equal((await asUser(db, simone, () => db.query(`select * from admin_tasks`))).rows.length, 0);
  assert.equal((await asUser(db, simone, () => db.query(`select * from admin_notes`))).rows.length, 0);
});

test('each person mutes their own sounds', async () => {
  await asUser(db, secretaria, () => db.query(`select set_my_notification_prefs(true, false)`));
  const rows = (await db.query(`select full_name, mute_whatsapp, mute_chat from staff order by full_name`)).rows;
  assert.deepEqual(rows.map((r) => `${r.full_name}:${r.mute_whatsapp}:${r.mute_chat}`), ['Ana:true:false', 'Everson:false:false', 'Simone:false:false']);
});

test('stock sectors: anyone on the team creates them; names do not repeat', async () => {
  await asUser(db, secretaria, () => db.query(`insert into stock_sectors (name) values ('Café')`));
  await expectDbError(asUser(db, secretaria, () => db.query(`insert into stock_sectors (name) values ('cafe')`)), 'stock_sectors_name_idx');
});

test('team chat alerts can be silenced per group, only for oneself', async () => {
  const channels = (await db.query(`select id, name, agenda_id from chat_channels order by name`)).rows;
  const everson = await createStaff(db, { name: 'Doutor Alertas', role: 'admin', agendaName: 'Dr. Everson Rezeck' });
  const other = channels.find((c) => c.agenda_id && c.name !== 'Dr. Everson Rezeck');
  await asUser(db, everson, () => db.query(`select set_my_muted_channels($1::uuid[])`, [[other.id, other.id, '00000000-0000-0000-0000-000000000000']]));
  const row = await one(db, `select chat_muted_channels from staff where id = $1`, [everson]);
  assert.deepEqual(row.chat_muted_channels, [other.id], 'deduplicated, unknown ids dropped');
  const someoneElse = await createStaff(db, { name: 'Recepcao Alertas', role: 'secretaria' });
  assert.deepEqual((await one(db, `select chat_muted_channels from staff where id = $1`, [someoneElse])).chat_muted_channels, []);
  await asUser(db, everson, () => db.query(`select set_my_muted_channels('{}'::uuid[])`));
  assert.deepEqual((await one(db, `select chat_muted_channels from staff where id = $1`, [everson])).chat_muted_channels, []);
});

test('Financeiro: one password per person; without one, a secretary waits for Dr. Everson', async () => {
  const renata = await createStaff(db, { name: 'Renata Senha', role: 'secretaria' });
  const outra = await createStaff(db, { name: 'Outra Secretaria', role: 'secretaria' });
  const doutor = await createStaff(db, { name: 'Doutor Senha', role: 'admin' });
  await db.query(`delete from finance_pin`);
  const check = (user, pin) => asUser(db, user, async () => (await one(db, `select check_finance_pin($1) as r`, [pin])).r);

  await expectDbError(asUser(db, renata, () => db.query(`select set_staff_finance_pin($1, '7069')`, [renata])), 'acesso_negado');
  await expectDbError(asUser(db, doutor, () => db.query(`select set_staff_finance_pin($1, '7069')`, [simone])), 'usuario_invalido');
  await asUser(db, doutor, () => db.query(`select set_staff_finance_pin($1, '7069')`, [renata]));
  await asUser(db, doutor, () => db.query(`select set_staff_finance_pin($1, '0239')`, [doutor]));

  assert.equal(await check(renata, '7069'), 'ok');
  assert.equal(await check(renata, '0239'), 'errada', 'the doctor’s password is not hers');
  assert.equal(await check(doutor, '0239'), 'ok');
  assert.equal(await check(outra, '1234'), 'sem_senha');
  const people = await asUser(db, doutor, async () => (await db.query(`select full_name, has_pin from finance_pin_people()`)).rows);
  assert.ok(people.some((p) => p.full_name === 'Renata Senha' && p.has_pin));
  assert.equal((await asUser(db, renata, () => db.query(`select * from finance_pin_people()`))).rows.length, 0);
  assert.equal((await asUser(db, renata, () => db.query(`select * from staff_finance_pins`))).rows.length, 0, 'nobody reads the hashes');

  await asUser(db, doutor, () => db.query(`select set_staff_finance_pin($1, null)`, [renata]));
  assert.equal(await check(renata, '7069'), 'sem_senha');
});

test('the reception sees the money of every agenda except Dr. Everson’s', async () => {
  const shared = (await db.query(`select name, finance_shared from agendas order by sort_order`)).rows;
  assert.deepEqual(shared.map((a) => [a.name, a.finance_shared]), [
    ['Dr. Everson Rezeck', false], ['Simone Rezeck', true], ['Estética', true], ['Depilação a laser', true],
  ]);
});
