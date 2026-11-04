import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, connect, futureWeekday, TEST_DATABASE_URL, one } from '../helpers/db.js';

process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.CLINIC_API_KEY = 'chave-de-teste';

const { createDevServer } = await import('../../server/dev-server.js');
const { closePool } = await import('../../server/db.js');

// The agent books by name and WhatsApp number; it must land on the patient
// the clinic already has instead of creating a copy.
let server;
let base;
let db;
let monday;

before(async () => {
  resetDatabase();
  db = await connect();
  monday = await futureWeekday(db, 1, 7);
  server = createDevServer().listen(0);
  base = `http://localhost:${server.address().port}/api`;
  await db.query(`insert into patients (full_name, phone, email, birth_date, notes) values
    ('Helena Prado Martins', '(31) 98888-1111', 'helena@exemplo.com', '1980-05-02', null),
    ('Ana Lima', '(31) 97777-2222', null, null, null),
    ('Ana Lima', '(31) 96666-3333', null, null, null),
    ('Marta Rocha Dias', '(31) 95555-4444', null, '1975-01-10', null)`);
});

after(async () => {
  server.close();
  await closePool();
  await db.end();
});

async function call(path, body) {
  const res = await fetch(`${base}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'chave-de-teste' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json() };
}

const count = async (name) => (await one(db, `select count(*)::int as n from patients where full_name = $1`, [name])).n;

test('a known full name writing from a new number is the same patient; the new number becomes the main one', async () => {
  const res = await call('agenda/agendar', {
    agenda: 'estetica', data: monday, horario: '09:00',
    paciente: { nome: 'helena prado martins', telefone: '5531911112222' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.paciente_cadastrado, false);
  assert.equal(await count('Helena Prado Martins'), 1);
  const p = await one(db, `select phone, phone_alt, notes from patients where full_name = 'Helena Prado Martins'`);
  assert.equal(p.phone, '5531911112222');
  assert.equal(p.phone_alt, '(31) 98888-1111');
  assert.match(p.notes, /Telefone anterior: \(31\) 98888-1111/);

  // the old number still finds her
  const ctx = await call('pacientes/contexto', { telefone: '31988881111' });
  assert.equal(ctx.body.pacientes[0].paciente.nome, 'Helena Prado Martins');
});

test('the e-mail finds the patient too', async () => {
  const res = await call('pacientes/cadastrar', { nome: 'Helena P. Martins', email: 'HELENA@exemplo.com', telefone: '5531911112222' });
  assert.equal(res.body.ja_existia, true);
  assert.equal(res.body.paciente.nome, 'Helena Prado Martins');
});

test('two patients with the same name, or a different birth date, are not guessed: a new record is made', async () => {
  const homonym = await call('pacientes/cadastrar', { nome: 'Ana Lima', telefone: '31944445555' });
  assert.equal(homonym.body.ja_existia, false);
  assert.equal(await count('Ana Lima'), 3);

  const other = await call('pacientes/cadastrar', { nome: 'Marta Rocha Dias', telefone: '31933336666', data_nascimento: '02/02/1990' });
  assert.equal(other.body.ja_existia, false);
  const same = await call('pacientes/cadastrar', { nome: 'Marta Rocha Dias', telefone: '31922227777', data_nascimento: '10/01/1975' });
  assert.equal(same.body.ja_existia, true);
});

test('reactivation: lapsed patients with WhatsApp, nothing booked and not contacted; marking moves to the next batch', async () => {
  const agenda = (await one(db, `select id from agendas where name = 'Estética'`)).id;
  const mk = (name, phone, allow = true) => one(db, `insert into patients (full_name, phone, allow_messages) values ($1, $2, $3) returning id`, [name, phone, allow]);
  const old1 = await mk('Antiga Um', '(31) 91234-0001');
  const old2 = await mk('Antiga Dois', '(31) 91234-0002');
  const optedOut = await mk('Não Quer', '(31) 91234-0003', false);
  const recent = await mk('Recente', '(31) 91234-0004');
  const booked = await mk('Já Marcou', '(31) 91234-0005');
  const visit = (patient, months) => db.query(
    `insert into appointments (agenda_id, patient_id, starts_at, ends_at, status)
     values ($1, $2, now() - make_interval(months => $3), now() - make_interval(months => $3) + interval '1 hour', 'chegou')`,
    [agenda, patient.id, months],
  );
  await visit(old1, 14);
  await visit(old2, 20);
  await visit(optedOut, 20);
  await visit(recent, 2);
  await visit(booked, 20);
  await db.query(
    `insert into appointments (agenda_id, patient_id, starts_at, ends_at, status)
     values ($1, $2, now() + interval '10 days', now() + interval '10 days 1 hour', 'agendado')`,
    [agenda, booked.id],
  );

  const list = await call('pacientes/reativacao', { meses_sem_vir: 12 });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.deepEqual(list.body.pacientes.map((x) => x.paciente.nome), ['Antiga Um', 'Antiga Dois'], 'most recently lapsed first');
  assert.equal(list.body.pacientes[0].meses_sem_vir, 14);
  assert.equal(list.body.pacientes[0].paciente.whatsapp, '5531912340001');

  const marked = await call('pacientes/marcar_reativacao', { pacientes: [old1.id] });
  assert.equal(marked.body.marcados, 1);
  const next = await call('pacientes/reativacao', { meses_sem_vir: 12 });
  assert.deepEqual(next.body.pacientes.map((x) => x.paciente.nome), ['Antiga Dois']);

  const bad = await call('pacientes/reativacao', { limite: 9999 });
  assert.equal(bad.body.erro.codigo, 'campo_invalido');
});
