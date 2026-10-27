import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  resetDatabase, connect, one, agendaId, createPatient, futureWeekday, localTs, expectDbError,
} from '../helpers/db.js';

let db;
let everson;
let estetica;
let patient;
let monday;

before(async () => {
  resetDatabase();
  db = await connect();
  everson = await agendaId(db, 'Dr. Everson Rezeck');
  estetica = await agendaId(db, 'Estética');
  patient = await createPatient(db, { name: 'Maria Agenda' });
  monday = await futureWeekday(db, 1, 7);
});

after(() => db.end());

const book = (args) =>
  one(
    db,
    `select * from book_appointment(
       p_agenda_id => $1, p_patient_id => $2, p_starts_at => $3,
       p_ends_at => $4, p_appointment_type_id => $5, p_procedure_names => $6)`,
    [args.agenda, args.patient ?? patient, args.start, args.end ?? null, args.type ?? null, args.procedures ?? null],
  );

test('local times are converted with the clinic timezone (UTC-3)', async () => {
  const ts = await localTs(db, monday, '08:00');
  assert.equal(ts.toISOString(), `${monday}T11:00:00.000Z`);
});

test('availability follows working hours, step and default duration', async () => {
  const { rows } = await db.query(`select * from available_slots($1::date, $2)`, [monday, everson]);
  // 08:00–18:00, 40 min consulta, every 20 min: last start 17:20 => 29 slots
  assert.equal(rows.length, 29);
  assert.equal(rows[0].starts_at.toISOString(), `${monday}T11:00:00.000Z`);
  assert.equal((rows[0].ends_at - rows[0].starts_at) / 60000, 40);
});

test('availability honours the type duration (avaliação estética = 20 min)', async () => {
  const type = await one(db, `select id from appointment_types where agenda_id = $1 and name = 'Avaliação estética'`, [everson]);
  const { rows } = await db.query(`select * from available_slots($1::date, $2, $3)`, [monday, everson, type.id]);
  assert.equal(rows.length, 30);
  assert.equal((rows[0].ends_at - rows[0].starts_at) / 60000, 20);
});

test('no availability on a weekend day without hours', async () => {
  const sunday = await futureWeekday(db, 0, 7);
  const { rows } = await db.query(`select * from available_slots($1::date)`, [sunday]);
  assert.equal(rows.length, 0);
});

test('booking uses the default type duration and removes overlapping slots', async () => {
  const appt = await book({ agenda: everson, start: await localTs(db, monday, '09:00') });
  assert.equal(appt.status, 'agendado');
  assert.equal(appt.source, 'api');
  assert.equal((appt.ends_at - appt.starts_at) / 60000, 40);

  const { rows } = await db.query(`select starts_at from available_slots($1::date, $2)`, [monday, everson]);
  const starts = rows.map((r) => r.starts_at.toISOString());
  for (const t of ['08:40', '09:00', '09:20']) {
    assert.ok(!starts.includes((await localTs(db, monday, t)).toISOString()), `${t} should be taken`);
  }
  assert.ok(starts.includes((await localTs(db, monday, '09:40')).toISOString()));
});

test('booking rejects conflicts, closed hours, the past and foreign types', async () => {
  await expectDbError(book({ agenda: everson, start: await localTs(db, monday, '09:20') }), 'horario_indisponivel');
  await expectDbError(book({ agenda: everson, start: await localTs(db, monday, '17:40') }), 'fora_do_horario_de_atendimento');
  await expectDbError(book({ agenda: everson, start: await localTs(db, monday, '07:00') }), 'fora_do_horario_de_atendimento');
  await expectDbError(book({ agenda: everson, start: new Date(Date.now() - 3600_000) }), 'horario_no_passado');
  const foreign = await one(db, `select id from appointment_types where agenda_id = $1`, [estetica]);
  await expectDbError(
    book({ agenda: everson, start: await localTs(db, monday, '14:00'), type: foreign.id }),
    'tipo_invalido_para_agenda',
  );
});

test('odd times like 16:21 are accepted when they fit', async () => {
  const appt = await book({
    agenda: everson,
    start: await localTs(db, monday, '16:21'),
    end: await localTs(db, monday, '16:37'),
  });
  assert.equal((appt.ends_at - appt.starts_at) / 60000, 16);
});

test('procedures are matched by name ignoring case/accents, unknown ones are registered', async () => {
  const appt = await book({
    agenda: estetica,
    start: await localTs(db, monday, '10:00'),
    procedures: ['botox', 'LIMPEZA DE PELE', 'Microagulhamento', 'botox'],
  });
  const { rows } = await db.query(
    `select p.name, p.reminder_months from appointment_procedures ap
     join procedures p on p.id = ap.procedure_id where ap.appointment_id = $1 order by p.name`,
    [appt.id],
  );
  assert.deepEqual(rows.map((r) => r.name), ['Botox', 'Limpeza de pele', 'Microagulhamento']);
  assert.equal(rows.find((r) => r.name === 'Microagulhamento').reminder_months, null);
});

test('agenda blocks close slots for one agenda or the whole clinic', async () => {
  const tuesday = await futureWeekday(db, 2, 7);
  await db.query(
    `insert into agenda_blocks (agenda_id, starts_at, ends_at, reason) values ($1, $2, $3, 'Congresso')`,
    [everson, await localTs(db, tuesday, '00:00'), await localTs(db, tuesday, '23:59')],
  );
  let { rows } = await db.query(`select * from available_slots($1::date, $2)`, [tuesday, everson]);
  assert.equal(rows.length, 0);
  ({ rows } = await db.query(`select * from available_slots($1::date, $2)`, [tuesday, estetica]));
  assert.ok(rows.length > 0);
  await expectDbError(book({ agenda: everson, start: await localTs(db, tuesday, '10:00') }), 'horario_indisponivel');

  await db.query(
    `insert into agenda_blocks (agenda_id, starts_at, ends_at, reason) values (null, $1, $2, 'Feriado')`,
    [await localTs(db, tuesday, '12:00'), await localTs(db, tuesday, '14:00')],
  );
  ({ rows } = await db.query(`select * from available_slots($1::date, $2)`, [tuesday, estetica]));
  const noon = (await localTs(db, tuesday, '12:00')).getTime();
  assert.ok(rows.every((r) => r.ends_at.getTime() <= noon || r.starts_at.getTime() >= noon + 2 * 3600_000));
});

test('cancel frees the slot, is idempotent and refuses attended visits', async () => {
  const wednesday = await futureWeekday(db, 3, 7);
  const appt = await book({ agenda: everson, start: await localTs(db, wednesday, '11:00') });
  const cancelled = await one(db, `select * from cancel_appointment($1, 'Paciente desistiu')`, [appt.id]);
  assert.equal(cancelled.status, 'cancelado');
  assert.equal(cancelled.cancel_reason, 'Paciente desistiu');
  const again = await one(db, `select * from cancel_appointment($1)`, [appt.id]);
  assert.equal(again.status, 'cancelado');
  await book({ agenda: everson, start: await localTs(db, wednesday, '11:00') });

  const done = await book({ agenda: everson, start: await localTs(db, wednesday, '15:00') });
  await db.query(`update appointments set status = 'chegou' where id = $1`, [done.id]);
  await expectDbError(one(db, `select * from cancel_appointment($1)`, [done.id]), 'agendamento_ja_realizado');
});

test('asking to reschedule or not showing up frees the slot for new bookings', async () => {
  const thursday = await futureWeekday(db, 4, 7);
  const appt = await book({ agenda: everson, start: await localTs(db, thursday, '08:00') });
  await db.query(`update appointments set status = 'pediu_remarcar' where id = $1`, [appt.id]);
  const other = await book({ agenda: everson, start: await localTs(db, thursday, '08:00') });
  assert.ok(other.id);
});

test('confirm moves agendado to confirmado and refuses cancelled ones', async () => {
  const friday = await futureWeekday(db, 5, 7);
  const appt = await book({ agenda: everson, start: await localTs(db, friday, '08:00') });
  const confirmed = await one(db, `select * from confirm_appointment($1)`, [appt.id]);
  assert.equal(confirmed.status, 'confirmado');
  await db.query(`select cancel_appointment($1)`, [appt.id]);
  await expectDbError(one(db, `select * from confirm_appointment($1)`, [appt.id]), 'agendamento_cancelado');
});

test('reschedule keeps the duration, may overlap its own old slot and resets to agendado', async () => {
  const friday = await futureWeekday(db, 5, 7);
  const appt = await book({ agenda: everson, start: await localTs(db, friday, '10:00') });
  await db.query(`select confirm_appointment($1)`, [appt.id]);
  const moved = await one(db, `select * from reschedule_appointment($1, $2)`, [appt.id, await localTs(db, friday, '10:20')]);
  assert.equal(moved.status, 'agendado');
  assert.equal(moved.starts_at.toISOString(), (await localTs(db, friday, '10:20')).toISOString());
  assert.equal((moved.ends_at - moved.starts_at) / 60000, 40);

  const blocker = await book({ agenda: everson, start: await localTs(db, friday, '14:00') });
  await expectDbError(
    one(db, `select * from reschedule_appointment($1, $2)`, [appt.id, await localTs(db, friday, '14:20')]),
    'horario_indisponivel',
  );
  assert.ok(blocker.id);
});

test('rescheduling to another agenda switches to that agenda\'s default type', async () => {
  const friday = await futureWeekday(db, 5, 7);
  const appt = await book({ agenda: everson, start: await localTs(db, friday, '16:00') });
  const moved = await one(db, `select * from reschedule_appointment($1, $2, null, $3)`, [
    appt.id, await localTs(db, friday, '16:00'), estetica,
  ]);
  const type = await one(db, `select name, agenda_id from appointment_types where id = $1`, [moved.appointment_type_id]);
  assert.equal(moved.agenda_id, estetica);
  assert.equal(type.agenda_id, estetica);
});

test('two simultaneous bookings for the same slot: exactly one wins', async () => {
  const day = await futureWeekday(db, 1, 14);
  const start = await localTs(db, day, '13:00');
  const clients = await Promise.all([connect(), connect(), connect()]);
  try {
    const results = await Promise.allSettled(
      clients.map((c) =>
        c.query(`select * from book_appointment(p_agenda_id => $1, p_patient_id => $2, p_starts_at => $3)`, [
          everson, patient, start,
        ]),
      ),
    );
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.message.includes('horario_indisponivel')));
  } finally {
    await Promise.all(clients.map((c) => c.end()));
  }
});

test('manual (screen) inserts may overlap, e.g. the 4 aesthetics beds', async () => {
  const day = await futureWeekday(db, 2, 14);
  const start = await localTs(db, day, '09:00');
  const end = await localTs(db, day, '10:00');
  for (let i = 0; i < 4; i++) {
    await db.query(
      `insert into appointments (agenda_id, patient_id, starts_at, ends_at) values ($1, $2, $3, $4)`,
      [estetica, patient, start, end],
    );
  }
  const { rows } = await db.query(`select count(*)::int as n from appointments where agenda_id = $1 and starts_at = $2`, [estetica, start]);
  assert.equal(rows[0].n, 4);
});
