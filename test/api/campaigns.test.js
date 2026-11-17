import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  resetDatabase, connect, one, agendaId, createPatient, createStaff, asUser, expectDbError, TEST_DATABASE_URL,
} from '../helpers/db.js';

process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.CRON_SECRET = 'segredo-cron';
process.env.CAMPAIGN_WEBHOOK_TIMEOUT_MS = '400';

const { createDevServer } = await import('../../server/dev-server.js');
const { closePool } = await import('../../server/db.js');

let db;
let api;
let base;
let receiver;
let hookUrl;
let received = [];
let failNext = 0;
let slowNext = 0;
let superadmin;
let admin;
let estetica;

before(async () => {
  resetDatabase();
  db = await connect();
  api = createDevServer().listen(0);
  base = `http://localhost:${api.address().port}/api`;
  receiver = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString()));
      const slow = slowNext-- > 0;
      setTimeout(() => {
        res.statusCode = failNext-- > 0 ? 500 : 200;
        res.end(res.statusCode === 200 ? '{"recebido":true}' : 'erro');
      }, slow ? 900 : 0);
    });
  }).listen(0);
  hookUrl = `http://localhost:${receiver.address().port}/campanha`;
  superadmin = await createStaff(db, { name: 'Suporte Agencia', role: 'admin' });
  await db.query(`update staff set is_superadmin = true where id = $1`, [superadmin]);
  admin = await createStaff(db, { name: 'Doutor Admin', role: 'admin' });
  estetica = await agendaId(db, 'Estética');
});

after(async () => {
  api.close();
  receiver.close();
  await closePool();
  await db.end();
});

beforeEach(() => {
  received = [];
  failNext = 0;
  slowNext = 0;
});

const run = () => fetch(`${base}/cron/campanhas`, { method: 'POST', headers: { authorization: 'Bearer segredo-cron' } })
  .then(async (r) => ({ status: r.status, body: await r.json() }));

async function visit(patient, monthsAgo, agenda = estetica) {
  await db.query(
    `insert into appointments (agenda_id, patient_id, starts_at, ends_at, status, created_at)
     values ($1, $2, now() - make_interval(months => $3), now() - make_interval(months => $3) + interval '1 hour', 'chegou', now() - make_interval(months => $3) - interval '1 day')`,
    [agenda, patient, monthsAgo],
  );
}

async function newCampaign(fields = {}) {
  return asUser(db, superadmin, () => one(db,
    `insert into campaigns (name, webhook_url, message, batch_size, window_minutes, gap_min_seconds, gap_max_seconds, hour_start, hour_end, weekdays)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
    [fields.name ?? 'Campanha teste', fields.url ?? hookUrl, fields.message ?? 'Oferta de novembro', fields.batch ?? 20, fields.window ?? 60,
      fields.gapMin ?? 0, fields.gapMax ?? 0, fields.from ?? '00:00', fields.to ?? '23:59', fields.days ?? [0, 1, 2, 3, 4, 5, 6]]));
}

const fill = (campaign, filters, exclude = [], include = [], only = false) => asUser(db, superadmin, async () =>
  (await one(db, `select set_campaign_recipients($1, $2, $3, $4, $5) as n`, [campaign, filters, exclude, include, only])).n);
const start = (campaign) => asUser(db, superadmin, () => db.query(`select set_campaign_status($1, 'enviando')`, [campaign]));
const statuses = async (campaign) => (await db.query(
  `select p.full_name, r.status from campaign_recipients r join patients p on p.id = r.patient_id where r.campaign_id = $1 order by p.full_name`, [campaign],
)).rows.map((r) => `${r.full_name}:${r.status}`);

test('the audience: filters, and never anyone who opted out or has no phone', async () => {
  const ana = await createPatient(db, { name: 'Ana Campanha', phone: '(31) 98000-0001' });
  const bia = await createPatient(db, { name: 'Bia Campanha', phone: '(31) 98000-0002' });
  const cris = await createPatient(db, { name: 'Cris Campanha', phone: '(31) 98000-0003', allowMessages: false });
  const dani = await createPatient(db, { name: 'Dani Campanha', phone: null });
  await visit(ana, 2);
  await visit(bia, 14);
  await visit(cris, 14);
  await visit(dani, 14);
  const names = async (filters) => asUser(db, superadmin, async () =>
    (await db.query(`select full_name from campaign_audience($1) where full_name like '% Campanha'`, [filters])).rows.map((r) => r.full_name));
  assert.deepEqual(await names({}), ['Ana Campanha', 'Bia Campanha']);
  assert.deepEqual(await names({ sem_vir_ha_meses: 12 }), ['Bia Campanha']);
  assert.deepEqual(await names({ veio_nos_ultimos_meses: 6 }), ['Ana Campanha']);
  // last visit between two dates on the calendar (both ends included)
  const day = async (monthsAgo) => (await one(db, `select (clinic_today() - make_interval(months => $1))::date::text as d`, [monthsAgo])).d;
  assert.deepEqual(await names({ ultima_visita_de: await day(16), ultima_visita_ate: await day(10) }), ['Bia Campanha']);
  assert.deepEqual(await names({ ultima_visita_de: await day(3) }), ['Ana Campanha'], 'from a date until today');
  assert.deepEqual(await names({ ultima_visita_ate: await day(3) }), ['Bia Campanha'], 'up to a date');
  assert.deepEqual(await names({ ultima_visita_de: await day(2), ultima_visita_ate: await day(2) }), ['Ana Campanha'], 'a single day');
  assert.deepEqual(await names({ ultima_visita_de: await day(9), ultima_visita_ate: await day(5) }), []);
  assert.deepEqual(await names({ agendas: [estetica], busca: 'bia' }), ['Bia Campanha']);
  assert.deepEqual(await names({ agendas: [await agendaId(db, 'Simone Rezeck')] }), []);
  // the clinic admin sees no audience at all
  const forAdmin = await asUser(db, admin, async () => (await db.query(`select * from campaign_audience('{}')`)).rows.length);
  assert.equal(forAdmin, 0);
});

test('recipients: the filter minus exclusions plus inclusions; only drafts can change', async () => {
  const c = await newCampaign({ name: 'Recorte' });
  const eva = await createPatient(db, { name: 'Eva Recorte', phone: '(31) 98000-0011' });
  const fia = await createPatient(db, { name: 'Fia Recorte', phone: '(31) 98000-0012' });
  const gil = await createPatient(db, { name: 'Gil Recorte', phone: '(31) 98000-0013' });
  const hal = await createPatient(db, { name: 'Hal Recorte', phone: '(31) 98000-0014', allowMessages: false });
  assert.equal(await fill(c.id, { busca: 'Recorte' }, [fia], []), 2);
  assert.deepEqual(await statuses(c.id), ['Eva Recorte:pendente', 'Gil Recorte:pendente']);
  assert.equal(await fill(c.id, {}, [], [fia, hal], true), 1, 'only the chosen, and still not who opted out');
  assert.deepEqual(await statuses(c.id), ['Fia Recorte:pendente']);
  await start(c.id);
  await expectDbError(fill(c.id, {}, [], [eva], true), 'campanha_nao_editavel');
  await asUser(db, superadmin, () => db.query(`select set_campaign_status($1, 'cancelada')`, [c.id]));
  assert.ok(gil);
});

test('the pace: a batch per window, then it waits for the next window', async () => {
  const c = await newCampaign({ name: 'Ritmo', batch: 2, window: 60, gapMin: 0, gapMax: 0 });
  for (const n of ['Ivo', 'Jo', 'Lu']) await createPatient(db, { name: `${n} Ritmo`, phone: `(31) 98000-01${n.length}${n.charCodeAt(0) % 10}` });
  assert.equal(await fill(c.id, { busca: 'Ritmo' }), 3);
  await start(c.id);
  const { body } = await run();
  assert.equal(body.campanhas.enviados, 2, 'two right away (no gap), then the window is full');
  assert.equal(received.length, 2);
  const p = received[0];
  assert.equal(p.tipo, 'campanha');
  assert.equal(p.campanha, 'Ritmo');
  assert.equal(p.mensagem, 'Oferta de novembro');
  assert.match(p.telefone, /^55319800001/);
  assert.match(p.nome, / Ritmo$/);
  assert.equal(p.tentativa, 1);
  assert.equal(p.total_visitas, 0);
  assert.equal(p.ultima_visita, '');
  assert.match(p.resumo, /Ainda não veio à clínica\. Nada agendado\.$/);
  assert.ok(Object.values(p).every((v) => ['string', 'number', 'boolean'].includes(typeof v)), 'flat: no nested objects');
  const campaign = await one(db, `select * from campaigns where id = $1`, [c.id]);
  const wait = (campaign.next_send_at - campaign.window_started_at) / 60000;
  assert.equal(Math.round(wait), 60, 'next one an hour after the window started');
  assert.equal((await run()).body.campanhas.enviados, 0, 'nothing before the next window');

  await db.query(`update campaigns set next_send_at = now(), window_started_at = now() - interval '61 minutes' where id = $1`, [c.id]);
  assert.equal((await run()).body.campanhas.enviados, 1);
  const done = await one(db, `select status, finished_at from campaigns where id = $1`, [c.id]);
  assert.equal(done.status, 'concluida');
  assert.ok(done.finished_at);
  assert.deepEqual((await statuses(c.id)).map((s) => s.split(':')[1]), ['enviado', 'enviado', 'enviado']);
});

test('the gap between messages and the allowed hours', async () => {
  const c = await newCampaign({ name: 'Intervalo', batch: 10, gapMin: 30, gapMax: 60 });
  await createPatient(db, { name: 'Mel Intervalo', phone: '(31) 98000-0201' });
  await createPatient(db, { name: 'Nina Intervalo', phone: '(31) 98000-0202' });
  await fill(c.id, { busca: 'Intervalo' });
  await start(c.id);
  assert.equal((await run()).body.campanhas.enviados, 1, 'one, then the gap');
  const gap = (await one(db, `select extract(epoch from next_send_at - now())::int as s from campaigns where id = $1`, [c.id])).s;
  assert.ok(gap >= 28 && gap <= 60, `gap of ${gap}s`);
  assert.equal((await run()).body.campanhas.enviados, 0);

  // outside the hours: nothing goes, and the clock moves to the next opening
  const local = await one(db, `select (now() at time zone clinic_tz())::time as t`);
  const [h] = local.t.split(':').map(Number);
  const closedFrom = `${String((h + 2) % 24).padStart(2, '0')}:00`;
  const closedTo = `${String((h + 3) % 24).padStart(2, '0')}:00`;
  if (closedTo > closedFrom) {
    await db.query(`update campaigns set hour_start = $2, hour_end = $3, next_send_at = now() where id = $1`, [c.id, closedFrom, closedTo]);
    assert.equal((await run()).body.campanhas.enviados, 0);
    const next = await one(db, `select to_char(next_send_at at time zone clinic_tz(), 'HH24:MI') as t from campaigns where id = $1`, [c.id]);
    assert.equal(next.t, closedFrom);
  }
  await asUser(db, superadmin, () => db.query(`select set_campaign_status($1, 'cancelada')`, [c.id]));
});

test('a failing webhook retries later, then gives up after 3 attempts; pause and resume', async () => {
  const c = await newCampaign({ name: 'Falha', batch: 10 });
  await createPatient(db, { name: 'Olga Falha', phone: '(31) 98000-0301' });
  await fill(c.id, { busca: 'Falha' });
  await start(c.id);
  failNext = 10;
  assert.equal((await run()).body.campanhas.falhas, 1);
  let r = await one(db, `select * from campaign_recipients where campaign_id = $1`, [c.id]);
  assert.equal(r.status, 'pendente');
  assert.match(r.last_error, /500/);
  assert.ok(r.locked_until > new Date(), 'waits 5 minutes before the next try');

  await asUser(db, superadmin, () => db.query(`select set_campaign_status($1, 'pausada')`, [c.id]));
  await db.query(`update campaign_recipients set locked_until = null where campaign_id = $1`, [c.id]);
  const paused = (await run()).body.campanhas;
  assert.equal(paused.enviados + paused.falhas, 0, 'paused: nothing goes');
  await asUser(db, superadmin, () => db.query(`select set_campaign_status($1, 'enviando')`, [c.id]));
  for (let i = 0; i < 2; i++) {
    await db.query(`update campaign_recipients set locked_until = null where campaign_id = $1`, [c.id]);
    await db.query(`update campaigns set next_send_at = now() where id = $1`, [c.id]);
    await run();
  }
  r = await one(db, `select * from campaign_recipients where campaign_id = $1`, [c.id]);
  assert.equal(r.status, 'erro');
  assert.equal(r.attempts, 3);
  assert.equal((await one(db, `select status from campaigns where id = $1`, [c.id])).status, 'concluida');
});

test('only the super admin sees campaigns; the endpoint needs the cron secret or the database token', async () => {
  const c = await newCampaign({ name: 'Secreta' });
  assert.equal(await asUser(db, admin, async () => (await db.query(`select * from campaigns`)).rows.length), 0);
  await expectDbError(asUser(db, admin, () => db.query(`select set_campaign_status($1, 'enviando')`, [c.id])), 'acesso_negado');
  await expectDbError(asUser(db, superadmin, () => db.query(`select * from claim_campaign_messages()`)), 'permission denied');
  const denied = await fetch(`${base}/cron/campanhas`, { method: 'POST' });
  assert.equal(denied.status, 401);
  const { token } = await one(db, `select token from private.internal_tokens where name = 'cron'`);
  const ok = await fetch(`${base}/cron/campanhas`, { method: 'POST', headers: { 'x-cron-token': token } });
  assert.equal(ok.status, 200);
});

test('the database job calls the server only when a message is due', async () => {
  await db.query(`create schema if not exists net;
    create table if not exists net.calls (url text, headers jsonb);
    create or replace function net.http_post(url text, body jsonb, headers jsonb, timeout_milliseconds integer) returns bigint
    language sql as $$ insert into net.calls values (url, headers); select 1::bigint $$;
    delete from net.calls;
    update campaigns set status = 'cancelada', next_send_at = null where status in ('enviando', 'pausada');`);
  assert.equal((await one(db, `select ping_campaign_dispatch() as r`)).r, 'nada a enviar');
  const c = await newCampaign({ name: 'Ping' });
  await createPatient(db, { name: 'Paz Ping', phone: '(31) 98000-0401' });
  await fill(c.id, { busca: 'Ping' });
  await start(c.id);
  assert.equal((await one(db, `select ping_campaign_dispatch() as r`)).r, 'não configurado');
  await db.query(`update settings set value = '"https://clinica.example.com"' where key = 'app_url'`);
  assert.equal((await one(db, `select ping_campaign_dispatch() as r`)).r, 'chamado');
  assert.equal((await one(db, `select url from net.calls`)).url, 'https://clinica.example.com/api/cron/campanhas');
  await db.query(`update settings set value = 'null' where key = 'app_url'`);
});

test('a webhook that does not answer in time counts as sent without confirmation, never twice', async () => {
  const c = await newCampaign({ name: 'Lenta', batch: 10 });
  await createPatient(db, { name: 'Rita Lenta', phone: '(31) 98000-0401' });
  await fill(c.id, { busca: 'Lenta' });
  await db.query(`update campaigns set status = 'cancelada' where id <> $1 and status = 'enviando'`, [c.id]);
  await start(c.id);
  slowNext = 1;
  assert.equal((await run()).body.campanhas.enviados, 1);
  const r = await one(db, `select * from campaign_recipients where campaign_id = $1`, [c.id]);
  assert.equal(r.status, 'enviado');
  assert.ok(r.sent_at);
  assert.match(r.last_error, /sem confirmação/);
  assert.equal((await one(db, `select status from campaigns where id = $1`, [c.id])).status, 'concluida');
  await run();
  assert.equal(received.length, 1, 'never sent again');
  assert.equal(received[0].teste, false);
});

test('"Enviar teste": the webhook gets a made-up patient with teste: true; only the super admin can', async () => {
  const { testCampaignWebhook } = await import('../../server/webhook-test.js');
  const staff = (id) => one(db, `select * from staff where id = $1`, [id]);
  await assert.rejects(testCampaignWebhook({ url: hookUrl }, null, await staff(admin)), /super admin/);
  await assert.rejects(testCampaignWebhook({ url: 'ftp://x' }, null, await staff(superadmin)), /https/);

  const ok = await testCampaignWebhook({ url: hookUrl, nome: 'Black Friday', mensagem: 'Oferta', telefone: '(31) 99999-1234' }, null, await staff(superadmin));
  assert.equal(ok.recebido, true);
  assert.equal(ok.status_http, 200);
  assert.equal(ok.resposta, '{"recebido":true}');
  const sent = received.at(-1);
  // one flat level: every field is text or a number
  assert.deepEqual(Object.keys(sent), [
    'tipo', 'teste', 'campanha', 'mensagem', 'envio_id', 'tentativa', 'nome', 'primeiro_nome', 'telefone', 'idade',
    'ultima_visita', 'dias_desde_ultima_visita', 'ultima_visita_agenda', 'ultima_visita_procedimentos', 'total_visitas',
    'procedimentos_realizados', 'retornos_pendentes', 'proximo_agendamento', 'resumo', 'paciente_id', 'campanha_id',
  ]);
  assert.ok(Object.values(sent).every((v) => ['string', 'number', 'boolean'].includes(typeof v)));
  assert.equal(sent.teste, true);
  assert.equal(sent.campanha, 'Black Friday');
  assert.equal(sent.mensagem, 'Oferta');
  assert.equal(sent.telefone, '5531999991234', 'your phone, to see it arrive');
  assert.equal(sent.ultima_visita_procedimentos, 'Botox');
  assert.match(sent.ultima_visita, /^\d{2}\/\d{2}\/\d{4}$/);
  assert.match(sent.resumo, /^Paciente Teste da Silva, 36 anos\. 3 visita\(s\); a última em/);

  const fictitious = await testCampaignWebhook({ url: hookUrl }, null, await staff(superadmin));
  assert.equal(fictitious.enviado.telefone, '5531900000000');

  failNext = 1;
  const failed = await testCampaignWebhook({ url: hookUrl }, null, await staff(superadmin));
  assert.deepEqual([failed.recebido, failed.status_http, failed.resposta], [false, 500, 'erro']);
  slowNext = 1;
  const slow = await testCampaignWebhook({ url: hookUrl }, null, await staff(superadmin));
  assert.equal(slow.recebido, false);
  assert.equal(slow.incerto, true);
  const down = await testCampaignWebhook({ url: 'http://localhost:1/nada' }, null, await staff(superadmin));
  assert.equal(down.recebido, false);
  assert.match(down.erro, /nada respondendo|não foi possível conectar/);
});

test('"Enviar teste" for the reminder, birthday and no-show webhooks: same flat format as a real send', async () => {
  const { testWebhook } = await import('../../server/webhook-test.js');
  const me = await one(db, `select * from staff where id = $1`, [superadmin]);
  const flat = (o) => Object.values(o).every((v) => ['string', 'number', 'boolean'].includes(typeof v));

  const lembrete = await testWebhook({ tipo: 'lembrete', url: hookUrl, telefone: '31999991234' }, null, me);
  assert.equal(lembrete.recebido, true);
  let sent = received.at(-1);
  assert.deepEqual([sent.tipo, sent.teste, sent.procedimento, sent.telefone], ['lembrete_retorno', true, 'Botox', '5531999991234']);
  assert.match(sent.data_retorno_prevista, /^\d{2}\/\d{2}\/\d{4}$/);
  assert.ok(flat(sent));

  await testWebhook({ tipo: 'aniversario', url: hookUrl }, null, me);
  sent = received.at(-1);
  assert.deepEqual([sent.tipo, sent.teste, sent.telefone], ['aniversario', true, '5531900000000']);
  assert.equal(sent.data_nascimento.slice(0, 5), new Date().toISOString().slice(5, 10).split('-').reverse().join('/'), 'born today');
  assert.ok(flat(sent));

  await testWebhook({ tipo: 'falta', url: hookUrl }, null, me);
  sent = received.at(-1);
  assert.deepEqual([sent.tipo, sent.teste, sent.agendamento_agenda, sent.minutos_desde_o_horario], ['falta', true, 'Dr. Everson Rezeck', 125]);
  assert.ok(flat(sent));

  await assert.rejects(testWebhook({ tipo: 'outro', url: hookUrl }, null, me), /desconhecido/);
  await assert.rejects(testWebhook({ tipo: 'falta', url: hookUrl }, null, await one(db, `select * from staff where id = $1`, [admin])), /super admin/);
});
