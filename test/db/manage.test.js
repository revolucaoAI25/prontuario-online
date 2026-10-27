import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, connect, one, createStaff, asUser, createPatient, agendaId, expectDbError } from '../helpers/db.js';

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

const visibleChannels = (user) => asUser(db, user, async () => (await db.query(`select name from chat_channels order by name`)).rows.map((r) => r.name));

test('groups: Recepção is for everyone; a new group reaches only the people chosen', async () => {
  assert.ok((await visibleChannels(simone)).includes('Recepção'));
  assert.ok((await visibleChannels(simone)).includes('Simone Rezeck'));
  assert.ok(!(await visibleChannels(simone)).includes('Estética'));

  const group = await asUser(db, admin, async () => one(db, `insert into chat_channels (name) values ('Diretoria') returning id`));
  assert.ok(!(await visibleChannels(simone)).includes('Diretoria'));
  assert.ok((await visibleChannels(secretaria)).includes('Diretoria'), 'secretaries see every group');
  await asUser(db, admin, () => db.query(`insert into chat_channel_members (channel_id, staff_id) values ($1, $2)`, [group.id, simone]));
  assert.ok((await visibleChannels(simone)).includes('Diretoria'));

  await expectDbError(asUser(db, secretaria, () => db.query(`insert into chat_channels (name) values ('Paralelo')`)), 'row-level security');
  const deleted = await asUser(db, admin, async () => (await db.query(`delete from chat_channels where id = $1`, [group.id])).rowCount);
  assert.equal(deleted, 1);
});

test('deleting a procedure: unused ones go away, used ones are archived and keep history', async () => {
  const unused = await one(db, `insert into procedures (name) values ('Procedimento de teste') returning id`);
  assert.equal((await asUser(db, admin, () => one(db, `select delete_procedure($1) as r`, [unused.id]))).r, 'apagado');
  assert.equal((await one(db, `select count(*)::int as n from procedures where id = $1`, [unused.id])).n, 0);

  const patient = await createPatient(db, { name: 'Paciente Botox' });
  const appt = await one(db,
    `insert into appointments (agenda_id, patient_id, starts_at, ends_at, status)
     values ($1, $2, now() - interval '10 days', now() - interval '10 days' + interval '40 minutes', 'chegou') returning id`,
    [await agendaId(db, 'Dr. Everson Rezeck'), patient]);
  await db.query(`select add_appointment_procedures($1, array['Botox'])`, [appt.id]);
  const botox = await one(db, `select id from procedures where name = 'Botox'`);
  assert.equal((await one(db, `select count(*)::int as n from reminders where procedure_id = $1 and status = 'pendente'`, [botox.id])).n, 1);

  await expectDbError(asUser(db, secretaria, () => db.query(`select delete_procedure($1)`, [botox.id])), 'acesso_negado');
  assert.equal((await asUser(db, admin, () => one(db, `select delete_procedure($1) as r`, [botox.id]))).r, 'arquivado');
  const after = await one(db, `select active, archived from procedures where id = $1`, [botox.id]);
  assert.deepEqual([after.active, after.archived], [false, true]);
  assert.equal((await one(db, `select count(*)::int as n from appointment_procedures where procedure_id = $1`, [botox.id])).n, 1, 'history kept');
  assert.equal((await one(db, `select count(*)::int as n from reminders where procedure_id = $1 and status = 'pendente'`, [botox.id])).n, 0, 'no more reminders for it');
});

test('deleting an agenda: archived when it has bookings, deleted when it has none', async () => {
  const empty = await one(db, `insert into agendas (name) values ('Agenda vazia') returning id`);
  assert.equal((await asUser(db, admin, () => one(db, `select delete_agenda($1) as r`, [empty.id]))).r, 'apagado');
  const everson = await agendaId(db, 'Dr. Everson Rezeck');
  assert.equal((await asUser(db, admin, () => one(db, `select delete_agenda($1) as r`, [everson]))).r, 'arquivado');
  assert.equal((await one(db, `select active from agendas where name = 'Dr. Everson Rezeck'`)).active, false);
});
