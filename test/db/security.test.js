import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, connect, one, createStaff, asUser, createPatient, expectDbError } from '../helpers/db.js';

let db;
let admin;
let secretaria;
let simone;
let outsider;

before(async () => {
  resetDatabase();
  db = await connect();
  admin = await createStaff(db, { name: 'Everson Rezeck', role: 'admin', agendaName: 'Dr. Everson Rezeck' });
  secretaria = await createStaff(db, { name: 'Ana Recepcao', role: 'secretaria' });
  simone = await createStaff(db, { name: 'Simone Rezeck', role: 'profissional', agendaName: 'Simone Rezeck' });
  outsider = (await one(db, `insert into auth.users (email) values ('x@y.z') returning id`)).id;
  await createPatient(db, { name: 'Paciente Existente' });
});

after(() => db.end());

test('a logged-in user who is not staff sees no data', async () => {
  const rows = await asUser(db, outsider, async () => (await db.query('select * from patients')).rows);
  assert.equal(rows.length, 0);
  await expectDbError(
    asUser(db, outsider, () => db.query(`insert into patients (full_name) values ('Intruso')`)),
    'row-level security',
  );
});

test('staff create patients with authorship; only the admin deletes them', async () => {
  const id = await asUser(db, secretaria, async () =>
    (await one(db, `insert into patients (full_name) values ('Nova Paciente') returning id, created_by`)),
  );
  assert.equal(id.created_by, secretaria);
  const deleted = await asUser(db, secretaria, async () => (await db.query(`delete from patients where id = $1`, [id.id])).rowCount);
  assert.equal(deleted, 0);
  const byAdmin = await asUser(db, admin, async () => (await db.query(`delete from patients where id = $1`, [id.id])).rowCount);
  assert.equal(byAdmin, 1);
});

test('record entries are signed by their author and only editable by them or the admin', async () => {
  const patient = await createPatient(db, { name: 'Prontuario Teste' });
  const entry = await asUser(db, simone, () =>
    one(db, `insert into record_entries (patient_id, content) values ($1, 'Limpeza') returning *`, [patient]),
  );
  assert.equal(entry.author_id, simone);
  const bySecretaria = await asUser(db, secretaria, async () =>
    (await db.query(`update record_entries set content = 'alterado' where id = $1`, [entry.id])).rowCount,
  );
  assert.equal(bySecretaria, 0);
  const byAdmin = await asUser(db, admin, async () =>
    (await db.query(`update record_entries set content = 'Limpeza + Hidratação' where id = $1`, [entry.id])).rowCount,
  );
  assert.equal(byAdmin, 1);
});

test('the finance report is for the admin only', async () => {
  const patient = await createPatient(db, { name: 'Pagante' });
  await asUser(db, secretaria, () =>
    db.query(
      `insert into payments (patient_id, amount, method, installments, status) values
       ($1, 500, 'cartao_credito', 2, 'pago'), ($1, 150, null, 1, 'pendente')`,
      [patient],
    ),
  );
  await expectDbError(
    asUser(db, secretaria, () => db.query(`select finance_summary(clinic_today(), clinic_today())`)),
    'acesso_negado',
  );
  const summary = await asUser(db, admin, async () =>
    (await one(db, `select finance_summary(clinic_today(), clinic_today()) as s`)).s,
  );
  assert.equal(Number(summary.total_pago), 500);
  assert.equal(Number(summary.total_pendente), 150);
  assert.equal(summary.por_forma[0].forma, 'cartao_credito');
});

test('a paid entry needs a payment method', async () => {
  const patient = await createPatient(db, { name: 'Sem Forma' });
  await expectDbError(
    db.query(`insert into payments (patient_id, amount, status) values ($1, 100, 'pago')`, [patient]),
    'payments_check',
  );
});

test('internal chat: professionals see their agenda channel, reception sees all', async () => {
  const names = async (user) =>
    asUser(db, user, async () => (await db.query(`select name from chat_channels order by name`)).rows.map((r) => r.name));
  assert.deepEqual(await names(simone), ['Simone Rezeck']);
  assert.equal((await names(secretaria)).length, 5);

  const recepcao = (await one(db, `select id from chat_channels where name = 'Recepção'`)).id;
  await expectDbError(
    asUser(db, simone, () => db.query(`insert into chat_messages (channel_id, body) values ($1, 'oi')`, [recepcao])),
    'row-level security',
  );
  const channel = (await one(db, `select id from chat_channels where name = 'Simone Rezeck'`)).id;
  await asUser(db, secretaria, () =>
    db.query(`insert into chat_messages (channel_id, body) values ($1, 'Paciente a caminho da sala 2')`, [channel]),
  );
  const unread = await asUser(db, simone, async () =>
    (await one(db, `select unread from unread_counts() where channel_id = $1`, [channel])).unread,
  );
  assert.equal(Number(unread), 1);
});

test('dispatch internals cannot be called by app users', async () => {
  await expectDbError(
    asUser(db, admin, () => db.query(`select * from claim_due_reminders()`)),
    'permission denied',
  );
});

test('configuration is admin-only', async () => {
  const changed = await asUser(db, secretaria, async () =>
    (await db.query(`update agendas set slot_step_minutes = 10`)).rowCount,
  );
  assert.equal(changed, 0);
  const byAdmin = await asUser(db, admin, async () =>
    (await db.query(`update procedures set reminder_months = 4 where name = 'Botox'`)).rowCount,
  );
  assert.equal(byAdmin, 1);
});

test('patient search matches accents, phone digits and record text', async () => {
  const p = await createPatient(db, { name: 'José Antônio Lima', phone: '(31) 98888-1234' });
  await db.query(`insert into record_entries (patient_id, content) values ($1, 'Aplicação de Ultraformer no rosto')`, [p]);
  const search = async (q, records = false) =>
    (await db.query(`select full_name from search_patients($1, 10, $2)`, [q, records])).rows.map((r) => r.full_name);
  assert.deepEqual(await search('jose antonio'), ['José Antônio Lima']);
  assert.deepEqual(await search('98888-1234'), ['José Antônio Lima']);
  assert.deepEqual(await search('ultraformer'), []);
  assert.deepEqual(await search('ultraformer', true), ['José Antônio Lima']);
});

test('WhatsApp numbers match patients with or without country code and 9th digit', async () => {
  const p = await createPatient(db, { name: 'Zap Paciente', phone: '(31) 97777-4321' });
  for (const jid of ['5531977774321', '553177774321', '31977774321']) {
    assert.equal((await one(db, `select match_patient_by_phone($1) as id`, [jid])).id, p, jid);
  }
  assert.equal((await one(db, `select match_patient_by_phone('5511977774321') as id`)).id, null, 'other DDD');
});
