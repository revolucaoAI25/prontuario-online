import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, connect, one, agendaId, createPatient } from '../helpers/db.js';

let db;
let estetica;

before(async () => {
  resetDatabase();
  db = await connect();
  estetica = await agendaId(db, 'Estética');
});

after(() => db.end());

// An appointment `daysAgo` days before today (clinic time), 10:00–11:00.
async function visit(patientId, daysAgo, procedures = [], status = 'chegou') {
  const appt = await one(
    db,
    `insert into appointments (agenda_id, patient_id, starts_at, ends_at, status)
     values ($1, $2,
             local_timestamp(clinic_today() - $3::int, '10:00'),
             local_timestamp(clinic_today() - $3::int, '11:00'), $4)
     returning id`,
    [estetica, patientId, daysAgo, status],
  );
  for (const name of procedures) {
    await db.query(`select add_appointment_procedures($1, array[$2])`, [appt.id, name]);
  }
  return appt.id;
}

async function pending(patientId) {
  const { rows } = await db.query(
    `select r.*, p.name as procedure_name
     from reminders r join procedures p on p.id = r.procedure_id
     where r.patient_id = $1 and r.status = 'pendente' order by p.name`,
    [patientId],
  );
  return rows;
}

async function expectedDue(daysAgo, months) {
  return (await one(db, `select ((clinic_today() - $1::int) + make_interval(months => $2))::date::text as d`, [daysAgo, months])).d;
}

const dateText = (d) => d.toISOString().slice(0, 10);

test('attended visit with a procedure creates a reminder due after its period', async () => {
  const p = await createPatient(db, { name: 'Ana Botox' });
  const appt = await visit(p, 10, ['Botox']);
  const rows = await pending(p);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].procedure_name, 'Botox');
  assert.equal(rows[0].source_appointment_id, appt);
  assert.equal(dateText(rows[0].due_on), await expectedDue(10, 4));
});

test('imported FastClinic history never creates reminders; a status set here does', async () => {
  const p = await createPatient(db, { name: 'Leda Legado' });
  const legacyVisit = async (daysAgo, status) => (await one(
    db,
    `insert into appointments (agenda_id, patient_id, starts_at, ends_at, status, source, legacy_synced_at)
     values ($1, $2, local_timestamp(clinic_today() - $3::int, '10:00'), local_timestamp(clinic_today() - $3::int, '11:00'), $4, 'legado', now())
     returning id`,
    [estetica, p, daysAgo, status],
  )).id;
  const imported = await legacyVisit(30, 'chegou');
  await db.query(`select add_appointment_procedures($1, array['Botox'])`, [imported]);
  assert.equal((await pending(p)).length, 0, 'imported visit is ignored');

  const bookedBeforeGoLive = await legacyVisit(1, 'confirmado');
  await db.query(`select add_appointment_procedures($1, array['Ultraformer'])`, [bookedBeforeGoLive]);
  await db.query(`update appointments set status = 'chegou' where id = $1`, [bookedBeforeGoLive]);
  assert.deepEqual((await pending(p)).map((r) => r.procedure_name), ['Ultraformer'], 'marked here after the import');
});

test('no reminder while the visit has not happened yet', async () => {
  const p = await createPatient(db, { name: 'Bia Agendada' });
  await visit(p, 3, ['Botox'], 'confirmado');
  assert.equal((await pending(p)).length, 0);
});

test('several procedures in one visit create one reminder each; redoing one resets only it', async () => {
  const p = await createPatient(db, { name: 'Carla Duas' });
  await visit(p, 40, ['Botox', 'Limpeza de pele']);
  let rows = await pending(p);
  assert.deepEqual(rows.map((r) => r.procedure_name), ['Botox', 'Limpeza de pele']);
  const [botoxBefore, limpezaBefore] = rows;

  const newer = await visit(p, 5, ['Botox']);
  rows = await pending(p);
  const botox = rows.find((r) => r.procedure_name === 'Botox');
  const limpeza = rows.find((r) => r.procedure_name === 'Limpeza de pele');
  assert.equal(botox.id, botoxBefore.id, 'the same queue entry is reused');
  assert.equal(botox.source_appointment_id, newer);
  assert.equal(dateText(botox.due_on), await expectedDue(5, 4));
  assert.equal(limpeza.id, limpezaBefore.id);
  assert.equal(dateText(limpeza.due_on), await expectedDue(40, 2), 'other procedures keep their date');
});

test('un-marking "chegou" rolls the reminder back; removing every visit cancels it', async () => {
  const p = await createPatient(db, { name: 'Dora Correção' });
  const old = await visit(p, 60, ['Botox']);
  const recent = await visit(p, 2, ['Botox']);
  assert.equal(dateText((await pending(p))[0].due_on), await expectedDue(2, 4));

  await db.query(`update appointments set status = 'confirmado' where id = $1`, [recent]);
  let rows = await pending(p);
  assert.equal(rows[0].source_appointment_id, old);
  assert.equal(dateText(rows[0].due_on), await expectedDue(60, 4));

  await db.query(`update appointments set status = 'nao_compareceu' where id = $1`, [old]);
  assert.equal((await pending(p)).length, 0);
  const cancelled = await one(db, `select status, closed_reason from reminders where patient_id = $1`, [p]);
  assert.deepEqual({ ...cancelled }, { status: 'cancelado', closed_reason: 'origem_desfeita' });

  await db.query(`update appointments set status = 'chegou' where id = $1`, [old]);
  assert.equal((await pending(p)).length, 1, 'restoring the visit restores the reminder');
});

test('removing a procedure from the visit removes its reminder', async () => {
  const p = await createPatient(db, { name: 'Eva Remove' });
  const appt = await visit(p, 10, ['Botox', 'Ultraformer']);
  await db.query(
    `delete from appointment_procedures where appointment_id = $1
     and procedure_id = (select id from procedures where name = 'Ultraformer')`,
    [appt],
  );
  assert.deepEqual((await pending(p)).map((r) => r.procedure_name), ['Botox']);
});

test('deleting an attended appointment recomputes the reminders', async () => {
  const p = await createPatient(db, { name: 'Fabi Apaga' });
  const appt = await visit(p, 10, ['Botox']);
  await db.query(`delete from appointments where id = $1`, [appt]);
  assert.equal((await pending(p)).length, 0);
});

test('changing a procedure period moves pending reminders, except manual dates', async () => {
  const p1 = await createPatient(db, { name: 'Gabi Periodo' });
  const p2 = await createPatient(db, { name: 'Hana Manual' });
  await visit(p1, 10, ['Ultraformer']);
  await visit(p2, 10, ['Ultraformer']);
  await db.query(`update reminders set due_on = '2030-01-01', manual_due = true where patient_id = $1`, [p2]);

  await db.query(`update procedures set reminder_months = 5 where name = 'Ultraformer'`);
  assert.equal(dateText((await pending(p1))[0].due_on), await expectedDue(10, 5));
  assert.equal(dateText((await pending(p2))[0].due_on), '2030-01-01');

  await visit(p2, 1, ['Ultraformer']);
  const reset = (await pending(p2))[0];
  assert.equal(reset.manual_due, false, 'a new visit overrides the manual date');
  assert.equal(dateText(reset.due_on), await expectedDue(1, 5));
  await db.query(`update procedures set reminder_months = 6 where name = 'Ultraformer'`);
});

test('procedures without a period use the default, and follow changes to it', async () => {
  const p = await createPatient(db, { name: 'Iris Padrao' });
  await visit(p, 10, ['Massagem modeladora']);
  assert.equal(dateText((await pending(p))[0].due_on), await expectedDue(10, 6));
  await db.query(`update settings set value = '7' where key = 'default_reminder_months'`);
  assert.equal(dateText((await pending(p))[0].due_on), await expectedDue(10, 7));
  await db.query(`update settings set value = '6' where key = 'default_reminder_months'`);
});

test('a sent or manually cancelled reminder is not recreated until the next visit', async () => {
  const p = await createPatient(db, { name: 'Julia Enviada' });
  await visit(p, 10, ['Botox', 'Ultraformer']);
  const [botox, ultra] = await pending(p);
  await db.query(`update reminders set status = 'enviado', sent_at = now() where id = $1`, [botox.id]);
  await db.query(`update reminders set status = 'cancelado', closed_reason = 'manual' where id = $1`, [ultra.id]);
  await db.query(`select recompute_patient_reminders($1)`, [p]);
  assert.equal((await pending(p)).length, 0);

  await visit(p, 1, ['Botox']);
  const rows = await pending(p);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].id, botox.id);
});

test('a reminder created by hand survives recomputation', async () => {
  const p = await createPatient(db, { name: 'Kel Manual' });
  await db.query(
    `insert into reminders (patient_id, procedure_id, due_on, manual_due, created_manually)
     values ($1, (select id from procedures where name = 'Botox'), clinic_today() + 30, true, true)`,
    [p],
  );
  await db.query(`select recompute_patient_reminders($1)`, [p]);
  assert.equal((await pending(p)).length, 1);
});

async function claim() {
  const { rows } = await db.query(`select * from claim_due_reminders(100)`);
  return rows;
}

// Visit exactly 4 months ago => Botox reminder due today.
async function dueTodayPatient(name, fields = {}) {
  const p = await createPatient(db, { name, ...fields });
  const days = (await one(db, `select clinic_today() - (clinic_today() - interval '4 months')::date as d`)).d;
  await visit(p, days, ['Botox']);
  return p;
}

test('dispatch queue: claim once, lease, back off on failure, then mark sent', async () => {
  const p = await dueTodayPatient('Lia Fila');
  let claimed = (await claim()).filter((r) => r.patient_id === p);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].procedure_name, 'Botox');
  assert.equal(claimed[0].attempts, 1);
  assert.equal((await claim()).filter((r) => r.patient_id === p).length, 0, 'leased rows are not claimed twice');

  await db.query(`select mark_reminder_failed($1, 'webhook 500')`, [claimed[0].reminder_id]);
  let row = await one(db, `select * from reminders where id = $1`, [claimed[0].reminder_id]);
  assert.equal(row.status, 'pendente');
  assert.ok(row.next_attempt_at > new Date(), 'retries later');
  assert.equal((await claim()).filter((r) => r.patient_id === p).length, 0);

  await db.query(`update reminders set next_attempt_at = now() - interval '1 minute' where id = $1`, [row.id]);
  claimed = (await claim()).filter((r) => r.patient_id === p);
  assert.equal(claimed[0].attempts, 2);
  await db.query(`select mark_reminder_sent($1)`, [row.id]);
  row = await one(db, `select * from reminders where id = $1`, [row.id]);
  assert.equal(row.status, 'enviado');
  assert.ok(row.sent_at);
});

test('dispatch gives up after 5 failed attempts', async () => {
  const p = await dueTodayPatient('Mel Erro');
  const r = await one(db, `select id from reminders where patient_id = $1`, [p]);
  await db.query(`update reminders set attempts = 5 where id = $1`, [r.id]);
  await db.query(`select mark_reminder_failed($1, 'timeout')`, [r.id]);
  assert.equal((await one(db, `select status from reminders where id = $1`, [r.id])).status, 'erro');
});

test('dispatch skips opted-out, phoneless and already-rebooked patients, and expires stale ones', async () => {
  const optedOut = await dueTodayPatient('Nina Optout', { allowMessages: false });
  const noPhone = await dueTodayPatient('Olga Semfone', { phone: null });
  const rebooked = await dueTodayPatient('Pia Remarcada');
  await db.query(
    `insert into appointments (agenda_id, patient_id, starts_at, ends_at)
     values ($1, $2, now() + interval '3 days', now() + interval '3 days 1 hour')`,
    [estetica, rebooked],
  );
  const stale = await createPatient(db, { name: 'Quel Antiga' });
  await visit(stale, 200, ['Botox']);

  const ids = (await claim()).map((r) => r.patient_id);
  for (const p of [optedOut, noPhone, rebooked, stale]) assert.ok(!ids.includes(p));
  const expired = await one(db, `select status, closed_reason from reminders where patient_id = $1`, [stale]);
  assert.deepEqual({ ...expired }, { status: 'expirado', closed_reason: 'vencido' });
  assert.equal((await pending(rebooked)).length, 1, 'still pending, will be sent if they skip the procedure');
});

test('birthday messages are claimed once per year, with the age', async () => {
  const p = await createPatient(db, { name: 'Rita Aniversario' });
  await db.query(`update patients set birth_date = (clinic_today() - interval '30 years')::date where id = $1`, [p]);
  const noPhone = await createPatient(db, { name: 'Sara Semfone', phone: null });
  await db.query(`update patients set birth_date = (clinic_today() - interval '20 years')::date where id = $1`, [noPhone]);

  let rows = (await db.query(`select * from claim_birthdays()`)).rows;
  const mine = rows.find((r) => r.patient_id === p);
  assert.equal(mine.age, 30);
  assert.ok(!rows.some((r) => r.patient_id === noPhone));
  rows = (await db.query(`select * from claim_birthdays()`)).rows;
  assert.ok(!rows.some((r) => r.patient_id === p), 'leased');

  await db.query(`select mark_birthday_sent($1)`, [mine.message_id]);
  await db.query(`update birthday_messages set locked_until = null where id = $1`, [mine.message_id]);
  rows = (await db.query(`select * from claim_birthdays()`)).rows;
  assert.ok(!rows.some((r) => r.patient_id === p), 'already sent this year');
});

test('29 February birthdays are celebrated on 28 February in non-leap years', async () => {
  const check = async (birth, day) => (await one(db, `select is_birthday($1::date, $2::date) as b`, [birth, day])).b;
  assert.equal(await check('2000-02-29', '2027-02-28'), true);
  assert.equal(await check('2000-02-29', '2028-02-28'), false);
  assert.equal(await check('2000-02-29', '2028-02-29'), true);
  assert.equal(await check('1990-05-10', '2027-05-10'), true);
  assert.equal(await check('1990-05-10', '2027-05-11'), false);
});
