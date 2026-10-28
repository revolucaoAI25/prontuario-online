import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, connect, one, createStaff, asUser, createPatient, agendaId, expectDbError } from '../helpers/db.js';

// Dr. Everson sees every agenda's takings; the reception sees Estética and
// Depilação (commissions) and the expenses; nobody else sees the doctors'.
let db;
let admin;
let secretaria;
let simone;
let patient;
const agenda = {};

before(async () => {
  resetDatabase();
  db = await connect();
  admin = await createStaff(db, { name: 'Everson', role: 'admin', agendaName: 'Dr. Everson Rezeck' });
  secretaria = await createStaff(db, { name: 'Ana', role: 'secretaria' });
  simone = await createStaff(db, { name: 'Simone', role: 'profissional', agendaName: 'Simone Rezeck' });
  patient = await createPatient(db, { name: 'Pagante' });
  for (const [key, name] of [['everson', 'Dr. Everson Rezeck'], ['simone', 'Simone Rezeck'], ['estetica', 'Estética'], ['depilacao', 'Depilação a laser']]) {
    agenda[key] = await agendaId(db, name);
  }
});
after(() => db.end());

// A visit that happened yesterday, paid at the front desk.
async function paidVisit(agendaKey, amount, method = 'pix') {
  const appt = await one(
    db,
    `insert into appointments (agenda_id, patient_id, starts_at, ends_at, status)
     values ($1, $2, local_timestamp(clinic_today() - 1, '10:00'), local_timestamp(clinic_today() - 1, '10:40'), 'chegou') returning id`,
    [agenda[agendaKey], patient],
  );
  await asUser(db, secretaria, () =>
    db.query(
      `insert into payments (patient_id, appointment_id, amount, method, status, occurred_on) values ($1, $2, $3, $4, 'pago', clinic_today() - 1)`,
      [patient, appt.id, amount, method],
    ),
  );
}

const summary = (user) => asUser(db, user, async () => (await one(db, `select finance_summary(clinic_today() - 1, clinic_today() - 1) as s`)).s);
const visibleAmounts = (user) =>
  asUser(db, user, async () => (await db.query(`select amount::int from payments order by amount`)).rows.map((r) => r.amount));

test('only Estética and Depilação are shared with the reception by default', async () => {
  const { rows } = await db.query(`select name from agendas where finance_shared order by name`);
  assert.deepEqual(rows.map((r) => r.name), ['Depilação a laser', 'Estética']);
});

test('a payment for a visit takes the visit agenda', async () => {
  await paidVisit('everson', 1500, 'cartao_credito');
  await paidVisit('simone', 800);
  await paidVisit('estetica', 260);
  await paidVisit('depilacao', 300, 'dinheiro');
  const { rows } = await db.query(`select a.name, p.amount::int from payments p join agendas a on a.id = p.agenda_id order by p.amount`);
  assert.deepEqual(rows.map((r) => `${r.name}:${r.amount}`), ['Estética:260', 'Depilação a laser:300', 'Simone Rezeck:800', 'Dr. Everson Rezeck:1500']);
});

test('the reception records any payment but reads only the shared agendas', async () => {
  assert.deepEqual(await visibleAmounts(admin), [260, 300, 800, 1500]);
  assert.deepEqual(await visibleAmounts(secretaria), [260, 300]);
  assert.deepEqual(await visibleAmounts(simone), [260, 300], 'professionals do not see the doctors either');

  const hidden = (await one(db, `select id from payments where amount = 1500`)).id;
  const changed = await asUser(db, secretaria, async () => (await db.query(`update payments set amount = 1 where id = $1`, [hidden])).rowCount);
  assert.equal(changed, 0, 'a hidden payment cannot be changed either');
});

test('the daily close: per agenda for the admin, shared agendas only for the reception', async () => {
  const mine = await summary(admin);
  assert.equal(Number(mine.total_pago), 2860);
  const everson = mine.por_agenda.find((a) => a.nome === 'Dr. Everson Rezeck');
  assert.equal(Number(everson.pago), 1500);
  assert.equal(everson.atendimentos, 1);
  assert.equal(everson.por_forma[0].forma, 'cartao_credito');
  assert.deepEqual(mine.por_agenda.map((a) => a.nome), ['Dr. Everson Rezeck', 'Simone Rezeck', 'Estética', 'Depilação a laser']);

  const reception = await summary(secretaria);
  assert.equal(Number(reception.total_pago), 560);
  assert.deepEqual(reception.por_agenda.map((a) => a.nome), ['Estética', 'Depilação a laser']);
  assert.ok(!JSON.stringify(reception).includes('1500'), 'the hidden total does not leave the database');

  await expectDbError(asUser(db, simone, () => db.query(`select finance_summary(clinic_today(), clinic_today())`)), 'acesso_negado');
});

test('turning sharing on in Ajustes shows that agenda to the reception', async () => {
  await asUser(db, admin, () => db.query(`update agendas set finance_shared = true where id = $1`, [agenda.simone]));
  assert.deepEqual(await visibleAmounts(secretaria), [260, 300, 800]);
  await asUser(db, admin, () => db.query(`update agendas set finance_shared = false where id = $1`, [agenda.simone]));
  const flipped = await asUser(db, secretaria, async () => (await db.query(`update agendas set finance_shared = true where id = $1`, [agenda.everson])).rowCount);
  assert.equal(flipped, 0, 'only the admin changes what the reception sees');
  assert.deepEqual(await visibleAmounts(secretaria), [260, 300]);
});

test('a counter sale with no agenda is visible to the team', async () => {
  await asUser(db, secretaria, () =>
    db.query(`insert into payments (patient_id, amount, method, status, occurred_on, description) values ($1, 45, 'pix', 'pago', clinic_today() - 1, 'Sabonete')`, [patient]),
  );
  const reception = await summary(secretaria);
  assert.equal(reception.por_agenda.at(-1).nome, 'Sem agenda (balcão)');
  assert.equal(Number(reception.por_agenda.at(-1).pago), 45);
});

test('expenses: the reception records and edits them, only the admin deletes, professionals do not see them', async () => {
  const expense = await asUser(db, secretaria, () =>
    one(db, `insert into expenses (occurred_on, description, category, amount, method) values (clinic_today() - 1, 'Cesta básica', 'Compras', 300, 'dinheiro') returning id, created_by`),
  );
  assert.equal(expense.created_by, secretaria);
  await asUser(db, secretaria, () => db.query(`insert into expenses (occurred_on, description, category, amount) values (clinic_today() - 1, 'Conta de luz', 'Contas', 150)`));
  await asUser(db, secretaria, () => db.query(`update expenses set amount = 310 where id = $1`, [expense.id]));

  const reception = await summary(secretaria);
  assert.equal(Number(reception.despesas_total), 460);
  assert.deepEqual(reception.despesas_por_categoria.map((c) => c.categoria), ['Compras', 'Contas']);
  assert.equal(Number((await summary(admin)).despesas_total), 460);

  assert.equal((await asUser(db, simone, () => db.query(`select * from expenses`))).rows.length, 0);
  await expectDbError(asUser(db, simone, () => db.query(`insert into expenses (description, amount) values ('x', 1)`)), 'row-level security');
  const deletedBySecretary = await asUser(db, secretaria, async () => (await db.query(`delete from expenses where id = $1`, [expense.id])).rowCount);
  assert.equal(deletedBySecretary, 0);
  const deletedByAdmin = await asUser(db, admin, async () => (await db.query(`delete from expenses where id = $1`, [expense.id])).rowCount);
  assert.equal(deletedByAdmin, 1);
});
