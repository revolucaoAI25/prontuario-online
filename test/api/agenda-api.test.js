import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, connect, futureWeekday, TEST_DATABASE_URL } from '../helpers/db.js';

process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.CLINIC_API_KEY = 'chave-de-teste';

const { createDevServer } = await import('../../server/dev-server.js');
const { closePool } = await import('../../server/db.js');

let server;
let base;
let db;
let monday;
let tuesday;

before(async () => {
  resetDatabase();
  db = await connect();
  monday = await futureWeekday(db, 1, 7);
  tuesday = (await db.query(`select ($1::date + 1)::text as d`, [monday])).rows[0].d;
  server = createDevServer().listen(0);
  base = `http://localhost:${server.address().port}/api`;
});

after(async () => {
  server.close();
  await closePool();
  await db.end();
});

async function call(path, body, { key = 'chave-de-teste', method = 'POST', raw } = {}) {
  const res = await fetch(`${base}/${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
    body: method === 'GET' ? undefined : raw ?? JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json() };
}

const brDate = (iso) => iso.split('-').reverse().join('/');

test('requests need the API key, POST and a known action', async () => {
  assert.equal((await call('agenda/agendas', {}, { key: null })).status, 401);
  assert.equal((await call('agenda/agendas', {}, { key: 'errada' })).status, 401);
  assert.equal((await call('agenda/agendas', null, { method: 'GET' })).status, 405);
  const unknown = await call('agenda/inexistente', {});
  assert.equal(unknown.status, 404);
  assert.match(unknown.body.erro.mensagem, /agendar/);
  assert.equal((await call('agenda/agendas', null, { raw: '{nope' })).body.erro.codigo, 'json_invalido');
});

test('agendas lists the four agendas, their types and the procedure catalog', async () => {
  const { status, body } = await call('agenda/agendas');
  assert.equal(status, 200);
  assert.deepEqual(body.agendas.map((a) => a.nome), ['Dr. Everson Rezeck', 'Simone Rezeck', 'Estética', 'Depilação a laser']);
  const everson = body.agendas[0];
  assert.deepEqual(everson.tipos.map((t) => [t.nome, t.duracao_minutos]), [['Consulta', 40], ['Avaliação estética', 20]]);
  assert.equal(body.procedimentos.find((p) => p.nome === 'Botox').retorno_meses, 4);
  assert.equal(body.procedimentos.find((p) => p.nome === 'Hidratação').retorno_meses, 6);
});

test('availability by agenda name, by type, across agendas and over a range', async () => {
  let { body } = await call('agenda/disponibilidade', { data: monday, agenda: 'everson' });
  assert.equal(body.disponibilidade.length, 1);
  assert.equal(body.disponibilidade[0].horarios.length, 29);
  assert.equal(body.disponibilidade[0].horarios[0], '08:00');
  assert.equal(body.disponibilidade[0].duracao_minutos, 40);

  ({ body } = await call('agenda/disponibilidade', { data: brDate(monday), agenda: 'Dr. Everson', tipo: 'avaliacao' }));
  assert.equal(body.disponibilidade[0].duracao_minutos, 20);

  ({ body } = await call('agenda/disponibilidade', { data: monday, tipo: 'consulta' }));
  assert.equal(body.disponibilidade.length, 4, '"consulta" exists in every agenda');

  ({ body } = await call('agenda/disponibilidade', { data_inicio: monday, data_fim: tuesday, agenda: 'depilação' }));
  assert.deepEqual(body.disponibilidade.map((d) => d.data), [monday, tuesday]);

  const tooLong = await call('agenda/disponibilidade', { data_inicio: monday, data_fim: '2099-01-01' });
  assert.equal(tooLong.status, 400);
});

test('booking a new patient, with procedures, then the slot disappears', async () => {
  const { status, body } = await call('agenda/agendar', {
    agenda: 'everson',
    data: brDate(monday),
    horario: '9h',
    paciente: { nome: 'Carolina Souza', telefone: '+55 31 98765-4321' },
    procedimentos: ['botox', 'Bioestimulador'],
    observacao: 'Primeira vez na clínica',
  });
  assert.equal(status, 200);
  assert.equal(body.paciente_cadastrado, true);
  const a = body.agendamento;
  assert.equal(a.data, monday);
  assert.equal(a.inicio, '09:00');
  assert.equal(a.fim, '09:40');
  assert.equal(a.tipo.nome, 'Consulta');
  assert.equal(a.status, 'agendado');
  assert.deepEqual(a.procedimentos, ['Bioestimulador', 'Botox']);
  assert.equal(a.paciente.nome, 'Carolina Souza');

  const free = (await call('agenda/disponibilidade', { data: monday, agenda: 'everson' })).body.disponibilidade[0].horarios;
  assert.ok(!free.includes('09:00') && !free.includes('09:20') && !free.includes('08:40'));
});

test('the same phone finds the same person, but a different first name is a new patient', async () => {
  const same = await call('agenda/agendar', {
    agenda: 'estetica', data: monday, horario: '10:00',
    paciente: { nome: 'carolina', telefone: '31987654321' },
  });
  assert.equal(same.body.paciente_cadastrado, false);
  assert.equal(same.body.agendamento.paciente.nome, 'Carolina Souza');

  const daughter = await call('agenda/agendar', {
    agenda: 'estetica', data: monday, horario: '11:00',
    paciente: { nome: 'Beatriz Souza', telefone: '31987654321' },
  });
  assert.equal(daughter.body.paciente_cadastrado, true);
  assert.equal(daughter.body.agendamento.paciente.nome, 'Beatriz Souza');
});

test('booking errors come back with a code and a readable message', async () => {
  const taken = await call('agenda/agendar', {
    agenda: 'everson', data: monday, horario: '09:20', paciente: { nome: 'Outra Pessoa' },
  });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.erro.codigo, 'horario_indisponivel');
  assert.match(taken.body.erro.mensagem, /não está disponível/);

  const closed = await call('agenda/agendar', {
    agenda: 'everson', data: monday, horario: '19:00', paciente: { nome: 'Outra Pessoa' },
  });
  assert.equal(closed.body.erro.codigo, 'fora_do_horario_de_atendimento');

  const noPatient = await call('agenda/agendar', { agenda: 'everson', data: monday, horario: '15:00' });
  assert.equal(noPatient.body.erro.codigo, 'campo_obrigatorio');

  const badDate = await call('agenda/agendar', {
    agenda: 'everson', data: '31/02/2027', horario: '15:00', paciente: { nome: 'X' },
  });
  assert.equal(badDate.body.erro.codigo, 'campo_invalido');

  const ambiguous = await call('agenda/agendar', {
    agenda: 'rezeck', data: monday, horario: '15:00', paciente: { nome: 'X' },
  });
  assert.equal(ambiguous.body.erro.codigo, 'agenda_ambigua');
});

test('list, confirm, reschedule and cancel an appointment', async () => {
  const booked = (await call('agenda/agendar', {
    agenda: 'simone', data: tuesday, horario: '14:00', paciente: { nome: 'Joana Lima', telefone: '31911112222' },
  })).body.agendamento;

  let list = (await call('agenda/agendamentos', { data: tuesday })).body;
  assert.ok(list.agendamentos.some((a) => a.id === booked.id));
  list = (await call('agenda/agendamentos', { data: tuesday, agenda: 'everson' })).body;
  assert.ok(!list.agendamentos.some((a) => a.id === booked.id));

  const confirmed = (await call('agenda/confirmar', { agendamento_id: booked.id })).body.agendamento;
  assert.equal(confirmed.status, 'confirmado');
  assert.equal(confirmed.status_descricao, 'Confirmado pelo paciente');

  const moved = (await call('agenda/remarcar', { agendamento_id: booked.id, data: monday, horario: '16:20' })).body.agendamento;
  assert.deepEqual([moved.data, moved.inicio, moved.fim, moved.status], [monday, '16:20', '17:00', 'agendado']);

  const toEverson = await call('agenda/remarcar', { agendamento_id: booked.id, data: monday, horario: '09:00', agenda: 'everson' });
  assert.equal(toEverson.status, 409);

  const cancelled = (await call('agenda/cancelar', { agendamento_id: booked.id, motivo: 'Viagem' })).body.agendamento;
  assert.equal(cancelled.status, 'cancelado');
  assert.equal(cancelled.motivo_cancelamento, 'Viagem');

  list = (await call('agenda/agendamentos', { data: monday })).body;
  assert.ok(!list.agendamentos.some((a) => a.id === booked.id), 'cancelled are hidden by default');
  list = (await call('agenda/agendamentos', { data: monday, incluir_cancelados: true })).body;
  assert.ok(list.agendamentos.some((a) => a.id === booked.id));

  const notFound = await call('agenda/cancelar', { agendamento_id: '00000000-0000-0000-0000-000000000000' });
  assert.equal(notFound.status, 404);
  const badId = await call('agenda/cancelar', { agendamento_id: 'abc' });
  assert.equal(badId.status, 400);
});

test('patients: search by phone returns upcoming appointments; register is idempotent', async () => {
  const found = (await call('pacientes/buscar', { telefone: '(31) 98765-4321' })).body;
  const carolina = found.pacientes.find((p) => p.nome === 'Carolina Souza');
  assert.ok(carolina.proximos_agendamentos.length >= 2);

  const byName = (await call('pacientes/buscar', { nome: 'joana' })).body;
  assert.equal(byName.pacientes[0].nome, 'Joana Lima');

  const created = (await call('pacientes/cadastrar', { nome: 'Marta Nova', cpf: '123.456.789-09', telefone: '31955554444' })).body;
  assert.equal(created.ja_existia, false);
  const again = (await call('pacientes/cadastrar', { nome: 'Marta', cpf: '12345678909', email: 'marta@ex.com' })).body;
  assert.equal(again.ja_existia, true);
  assert.equal(again.paciente.id, created.paciente.id);
  assert.equal(again.paciente.email, 'marta@ex.com', 'missing fields are filled in');
});

test('patients/contexto: history summary, procedures, pending returns and what is booked, by phone', async () => {
  const patient = (await db.query(
    `insert into patients (full_name, phone, birth_date) values ('Helena Contexto', '(31) 97777-1212', (clinic_today() - interval '35 years')::date) returning id`,
  )).rows[0].id;
  const estetica = (await db.query(`select id from agendas where name = 'Estética'`)).rows[0].id;
  const past = async (monthsAgo, status, procedures) => {
    const { rows } = await db.query(
      `insert into appointments (agenda_id, patient_id, starts_at, ends_at, status)
       values ($1, $2, local_timestamp((clinic_today() - make_interval(months => $3))::date, '10:00'),
               local_timestamp((clinic_today() - make_interval(months => $3))::date, '11:00'), $4) returning id`,
      [estetica, patient, monthsAgo, status],
    );
    if (procedures.length) await db.query(`select add_appointment_procedures($1, $2)`, [rows[0].id, procedures]);
  };
  await past(14, 'chegou', ['Limpeza de pele']);
  await past(5, 'nao_compareceu', []);
  await past(2, 'chegou', ['Botox', 'Limpeza de pele']);
  await call('agenda/agendar', { agenda: 'Estética', data: brDate(tuesday), horario: '14:00', paciente_id: patient, procedimentos: ['Hidratação'] });

  // WhatsApp-style number: country code, no punctuation
  const { status, body } = await call('pacientes/contexto', { telefone: '5531977771212' });
  assert.equal(status, 200);
  assert.equal(body.encontrado, true);
  const ctx = body.pacientes[0];
  assert.equal(ctx.paciente.nome, 'Helena Contexto');
  assert.equal(ctx.paciente.idade, 35);
  assert.equal(ctx.paciente.whatsapp, '5531977771212');
  assert.equal(ctx.historico.total_atendimentos, 2);
  assert.equal(ctx.historico.faltas, 1);
  assert.deepEqual(ctx.historico.ultimo_atendimento.procedimentos, ['Botox', 'Limpeza de pele']);
  assert.equal(ctx.historico.ultimo_atendimento.agenda.nome, 'Estética');
  assert.deepEqual(ctx.historico.procedimentos_realizados.map((p) => [p.nome, p.vezes]).sort(), [['Botox', 1], ['Limpeza de pele', 2]]);
  assert.equal(ctx.historico.ultimos_agendamentos.length, 3);
  assert.equal(ctx.agendamentos_futuros.length, 1);
  assert.equal(ctx.agendamentos_futuros[0].data, tuesday);
  assert.equal(ctx.agendamentos_futuros[0].inicio, '14:00');
  assert.deepEqual(ctx.agendamentos_futuros[0].procedimentos, ['Hidratação']);
  assert.deepEqual(ctx.retornos_pendentes.map((r) => r.procedimento).sort(), ['Botox', 'Limpeza de pele']);
  assert.match(ctx.resumo, /Helena Contexto, 35 anos\. .*2 atendimento\(s\).*Agendamentos futuros: .* às 14:00 na agenda Estética/);

  const none = (await call('pacientes/contexto', { telefone: '(11) 90000-0001' })).body;
  assert.deepEqual([none.encontrado, none.total], [false, 0]);
  assert.equal((await call('pacientes/contexto', {})).body.erro.codigo, 'campo_obrigatorio');
});
