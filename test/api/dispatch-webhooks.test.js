import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { resetDatabase, connect, one, agendaId, createPatient, TEST_DATABASE_URL } from '../helpers/db.js';

process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.CRON_SECRET = 'segredo-cron';
process.env.EVOLUTION_WEBHOOK_SECRET = 'segredo-evolution';
process.env.WEBHOOK_SIGNING_SECRET = 'segredo-assinatura';

const { createDevServer } = await import('../../server/dev-server.js');
const { closePool } = await import('../../server/db.js');

let db;
let api;
let base;
let receiver;
let receiverUrl;
let received = [];
let failNext = 0;

before(async () => {
  resetDatabase();
  db = await connect();
  api = createDevServer().listen(0);
  base = `http://localhost:${api.address().port}/api`;
  receiver = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      received.push({ body: JSON.parse(body), raw: body, signature: req.headers['x-clinica-assinatura'] });
      res.statusCode = failNext-- > 0 ? 500 : 200;
      res.end();
    });
  }).listen(0);
  receiverUrl = `http://localhost:${receiver.address().port}/hook`;
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
});

const cron = (secret = 'segredo-cron') =>
  fetch(`${base}/cron/disparos`, { headers: secret ? { authorization: `Bearer ${secret}` } : {} }).then(async (r) => ({ status: r.status, body: await r.json() }));

async function setting(key, value) {
  await db.query(`update settings set value = $2 where key = $1`, [key, JSON.stringify(value)]);
}

async function dueTodayBotox(name, phone) {
  const patient = await createPatient(db, { name, phone });
  const appt = await one(
    db,
    `insert into appointments (agenda_id, patient_id, starts_at, ends_at, status)
     values ($1, $2, local_timestamp((clinic_today() - interval '4 months')::date, '10:00'),
             local_timestamp((clinic_today() - interval '4 months')::date, '11:00'), 'chegou') returning id`,
    [await agendaId(db, 'Estética'), patient],
  );
  await db.query(`select add_appointment_procedures($1, array['Botox'])`, [appt.id]);
  return patient;
}

test('the cron endpoint requires the Vercel cron secret', async () => {
  assert.equal((await cron(null)).status, 401);
  assert.equal((await cron('errado')).status, 401);
});

test('nothing is sent while no webhook is configured', async () => {
  await dueTodayBotox('Sem Webhook', '(31) 91234-0000');
  const { body } = await cron();
  assert.deepEqual(body.lembretes, { configurado: false });
  assert.equal(received.length, 0);
});

test('due reminders are posted once, signed, then marked as sent', async () => {
  await setting('reminder_webhook_url', receiverUrl);
  const patient = await dueTodayBotox('Lara Lembrete', '(31) 98765-1111');
  const { body } = await cron();
  const mine = received.filter((r) => r.body.paciente.id === patient);
  assert.equal(mine.length, 1);
  const payload = mine[0].body;
  assert.equal(payload.tipo, 'lembrete_retorno');
  assert.equal(payload.procedimento.nome, 'Botox');
  assert.equal(payload.paciente.primeiro_nome, 'Lara');
  assert.equal(payload.paciente.whatsapp, '5531987651111');
  assert.equal(payload.procedimento.retorno_em_meses, 4);
  assert.equal(payload.data_retorno_prevista, payload.data_ultima_vez && (await one(db, `select due_on::text as d from reminders where patient_id = $1`, [patient])).d);
  assert.match(payload.data_ultima_vez, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(payload.dias_desde_ultima_vez >= 118 && payload.dias_desde_ultima_vez <= 124);
  assert.equal(payload.vezes_que_fez, 1);
  assert.equal(payload.atendimento_de_origem.agenda.nome, 'Estética');
  assert.deepEqual(payload.atendimento_de_origem.procedimentos, ['Botox']);
  assert.equal(payload.atendimento_de_origem.data, payload.data_ultima_vez);
  assert.equal(payload.historico.total_atendimentos, 1);
  assert.deepEqual(payload.agendamentos_futuros, []);
  assert.match(payload.resumo, /^Lara Lembrete\./);
  const expected = `sha256=${createHmac('sha256', 'segredo-assinatura').update(mine[0].raw).digest('hex')}`;
  assert.equal(mine[0].signature, expected);
  assert.ok(body.lembretes.enviados >= 1);

  const reminder = await one(db, `select status, sent_at from reminders where patient_id = $1`, [patient]);
  assert.equal(reminder.status, 'enviado');
  received = [];
  await cron();
  assert.equal(received.filter((r) => r.body.paciente.id === patient).length, 0, 'not sent twice');
});

test('a failing webhook keeps the reminder pending with a retry later', async () => {
  await setting('reminder_webhook_url', receiverUrl);
  const patient = await dueTodayBotox('Rui Retry', '(31) 98765-2222');
  failNext = 100;
  await cron();
  const reminder = await one(db, `select * from reminders where patient_id = $1`, [patient]);
  assert.equal(reminder.status, 'pendente');
  assert.match(reminder.last_error, /500/);
  assert.ok(reminder.next_attempt_at > new Date());
  failNext = 0;
  received = [];
  await cron();
  assert.equal(received.filter((r) => r.body.paciente.id === patient).length, 0, 'waits for the backoff');
});

test('birthdays are posted with the age', async () => {
  await setting('birthday_webhook_url', receiverUrl);
  const patient = await createPatient(db, { name: 'Bia Aniversario', phone: '(31) 98765-3333' });
  await db.query(`update patients set birth_date = (clinic_today() - interval '41 years')::date where id = $1`, [patient]);
  await cron();
  const payload = received.find((r) => r.body.tipo === 'aniversario' && r.body.paciente.id === patient)?.body;
  assert.equal(payload.idade, 41);
  assert.equal(payload.paciente.data_nascimento, payload.data_nascimento);
  assert.equal(payload.paciente.whatsapp, '5531987653333');
});

const evolution = (payload, secret = 'segredo-evolution') =>
  fetch(`${base}/webhooks/evolution?secret=${secret}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

const upsert = (key, message, extra = {}) => ({
  event: 'messages.upsert',
  instance: 'clinica',
  data: { key, pushName: 'Paciente', message, messageTimestamp: 1793000000, ...extra },
});

test('Evolution webhook rejects a wrong secret', async () => {
  assert.equal((await evolution(upsert({ id: 'x', remoteJid: '1@s.whatsapp.net' }, { conversation: 'oi' }), 'errado')).status, 401);
});

test('Evolution messages are stored once and linked to the patient by phone', async () => {
  const patient = await createPatient(db, { name: 'Zuleica Zap', phone: '(31) 99876-5432' });
  const msg = upsert({ id: 'MSG1', remoteJid: '5531998765432@s.whatsapp.net', fromMe: false }, { conversation: 'Posso remarcar?' });
  assert.deepEqual((await evolution(msg)).body, { ok: true, recebidas: 1, gravadas: 1, atualizadas: 0, midias: 0 });
  assert.equal((await evolution(msg)).body.gravadas, 0, 'idempotent');

  await evolution({
    event: 'SEND_MESSAGE',
    instance: 'clinica',
    data: { key: { id: 'MSG2', remoteJid: '553198765432@s.whatsapp.net', fromMe: true }, message: { extendedTextMessage: { text: 'Claro! Qual dia?' } }, messageTimestamp: 1793000100 },
  });

  const rows = (await db.query(`select * from whatsapp_messages where patient_id = $1 order by sent_at`, [patient])).rows;
  assert.deepEqual(rows.map((r) => [r.body, r.from_me]), [['Posso remarcar?', false], ['Claro! Qual dia?', true]]);
  const conversation = await one(db, `select * from whatsapp_conversations where patient_id = $1 limit 1`, [patient]);
  assert.equal(conversation.patient_name, 'Zuleica Zap');
});

test('Evolution groups, reactions and statuses are ignored; @lid chats use the sender phone', async () => {
  const groups = await evolution(upsert({ id: 'G1', remoteJid: '1203630@g.us' }, { conversation: 'grupo' }));
  assert.equal(groups.body.recebidas, 0);
  const reaction = await evolution(upsert({ id: 'R1', remoteJid: '5531911110000@s.whatsapp.net' }, { reactionMessage: { text: '👍' } }, { messageType: 'reactionMessage' }));
  assert.equal(reaction.body.recebidas, 0);
  const patient = await createPatient(db, { name: 'Lia Lid', phone: '(31) 97777-1212' });
  await evolution(upsert({ id: 'L1', remoteJid: '123456789@lid', senderPn: '5531977771212@s.whatsapp.net' }, { imageMessage: { caption: 'foto do resultado' } }));
  const row = await one(db, `select * from whatsapp_messages where wa_message_id = 'L1'`);
  assert.equal(row.patient_id, patient);
  assert.equal(row.body, 'foto do resultado');
  assert.equal(row.message_type, 'imageMessage');
});

test('a conversation keeps the contact name after we reply', async () => {
  await evolution(upsert({ remoteJid: '5531955556666@s.whatsapp.net', fromMe: false, id: 'NOME1' }, { conversation: 'Oi' }, { pushName: 'Bruno' }));
  await evolution(upsert({ remoteJid: '5531955556666@s.whatsapp.net', fromMe: true, id: 'NOME2' }, { conversation: 'Olá!' }, { messageTimestamp: 1793000100 }));
  const conv = await one(db, `select push_name, last_body, last_from_me from whatsapp_conversations where remote_jid = '5531955556666@s.whatsapp.net'`);
  assert.deepEqual([conv.push_name, conv.last_body, conv.last_from_me], ['Bruno', 'Olá!', true]);
});

test('delivery status only moves forward (sent → delivered → read)', async () => {
  await evolution(upsert({ remoteJid: '5531955557777@s.whatsapp.net', fromMe: true, id: 'ST1' }, { conversation: 'Confirmado!' }, { status: 'SERVER_ACK' }));
  const update = (status) => evolution({ event: 'messages.update', instance: 'clinica', data: { keyId: 'ST1', remoteJid: '5531955557777@s.whatsapp.net', fromMe: true, status } });
  const status = async () => (await one(db, `select status from whatsapp_messages where wa_message_id = 'ST1'`)).status;
  assert.equal(await status(), 'enviado');
  await update('READ');
  assert.equal(await status(), 'lido');
  await update('DELIVERY_ACK');
  assert.equal(await status(), 'lido', 'a late delivery receipt does not undo read');
  // Baileys-style payload
  await evolution({ event: 'MESSAGES_UPDATE', instance: 'clinica', data: [{ key: { id: 'ST1' }, update: { status: 5 } }] });
  assert.equal(await status(), 'lido');
});

test('media, locations and contacts are described; media waits to be downloaded', async () => {
  await evolution(upsert({ remoteJid: '5531955558888@s.whatsapp.net', fromMe: false, id: 'MID1' },
    { imageMessage: { mimetype: 'image/jpeg', caption: 'Olha a mancha', fileLength: '52344', url: 'https://mmg.whatsapp.net/x' } }));
  await evolution(upsert({ remoteJid: '5531955558888@s.whatsapp.net', fromMe: false, id: 'MID2' },
    { documentWithCaptionMessage: { message: { documentMessage: { mimetype: 'application/pdf', fileName: 'exame.pdf', caption: 'Meu exame' } } } }));
  await evolution(upsert({ remoteJid: '5531955558888@s.whatsapp.net', fromMe: false, id: 'MID3' },
    { locationMessage: { degreesLatitude: -19.9, degreesLongitude: -43.9, name: 'Clínica' } }));
  const { rows } = await db.query(`select wa_message_id, body, media_kind, media_status, media_mime, media_name, media_size
                                   from whatsapp_messages where wa_message_id like 'MID%' order by wa_message_id`);
  assert.deepEqual(rows.map((r) => [r.body, r.media_kind, r.media_status]), [
    ['Olha a mancha', 'imagem', 'pendente'],
    ['Meu exame', 'documento', 'pendente'],
    ['📍 Localização: Clínica https://maps.google.com/?q=-19.9,-43.9', null, null],
  ]);
  assert.equal(rows[0].media_size, '52344');
  assert.equal(rows[1].media_name, 'exame.pdf');
});

test('opening a conversation marks it read for the whole team', async () => {
  await evolution(upsert({ remoteJid: '5531955559999@s.whatsapp.net', fromMe: false, id: 'UN1' }, { conversation: 'Oi' }));
  await evolution(upsert({ remoteJid: '5531955559999@s.whatsapp.net', fromMe: false, id: 'UN2' }, { conversation: 'Alguém?' }, { messageTimestamp: 1793000050 }));
  const unread = async () => Number((await one(db, `select unread_count from whatsapp_conversations where remote_jid = '5531955559999@s.whatsapp.net'`)).unread_count);
  assert.equal(await unread(), 2);
  await db.query(`select mark_whatsapp_read('5531955559999@s.whatsapp.net')`);
  assert.equal(await unread(), 0);
});

test('a message that arrives late (server was offline) still counts as unread', async () => {
  const jid = '5531955550101@s.whatsapp.net';
  await evolution(upsert({ remoteJid: jid, fromMe: false, id: 'LATE1' }, { conversation: 'Bom dia' }));
  await db.query(`select mark_whatsapp_read($1)`, [jid]);
  // sent before the conversation was opened, but only reached the system now
  await evolution(upsert({ remoteJid: jid, fromMe: false, id: 'LATE2' }, { conversation: 'Consegue às 15h?' }, { messageTimestamp: 1793000010 }));
  const conv = await one(db, `select unread_count from whatsapp_conversations where remote_jid = $1`, [jid]);
  assert.equal(Number(conv.unread_count), 1);
  assert.ok((await one(db, `select whatsapp_unread_total() as n`)).n >= 1);
});

test('wrapped, template and button messages show their text; encrypted edits are skipped', async () => {
  const jid = '5531955550202@s.whatsapp.net';
  await evolution(upsert({ remoteJid: jid, fromMe: false, id: 'WR1' }, { ephemeralMessage: { message: { extendedTextMessage: { text: 'Mensagem temporária' } } } }, { messageType: 'ephemeralMessage' }));
  await evolution(upsert({ remoteJid: jid, fromMe: false, id: 'WR2' }, { viewOnceMessageV2: { message: { imageMessage: { mimetype: 'image/jpeg' } } } }));
  await evolution(upsert({ remoteJid: jid, fromMe: false, id: 'WR3' }, { templateMessage: { hydratedTemplate: { hydratedContentText: 'Seu pedido saiu', hydratedFooterText: 'Loja' } } }, { messageType: 'templateMessage' }));
  await evolution(upsert({ remoteJid: jid, fromMe: false, id: 'WR4' }, { interactiveMessage: { nativeFlowMessage: { buttons: [] } } }, { messageType: 'interactiveMessage' }));
  await evolution(upsert({ remoteJid: jid, fromMe: false, id: 'WR5' }, { lottieStickerMessage: { message: { stickerMessage: { mimetype: 'application/was' } } } }, { messageType: 'lottieStickerMessage' }));
  const skipped = await evolution(upsert({ remoteJid: jid, fromMe: false, id: 'WR6' }, { secretEncryptedMessage: { encPayload: {}, secretEncType: 2 } }, { messageType: 'secretEncryptedMessage' }));
  assert.equal(skipped.body.recebidas, 0);
  const { rows } = await db.query(`select wa_message_id, body, media_kind from whatsapp_messages where wa_message_id like 'WR%' order by wa_message_id`);
  assert.deepEqual(rows.map((r) => [r.wa_message_id, r.body, r.media_kind]), [
    ['WR1', 'Mensagem temporária', null],
    ['WR2', null, 'imagem'],
    ['WR3', 'Seu pedido saiu\nLoja', null],
    ['WR4', 'Mensagem com botões (abra no celular para ver as opções)', null],
    ['WR5', null, 'figurinha'],
  ]);
});

test('edited and deleted messages are marked, not lost', async () => {
  const jid = '5531955550303@s.whatsapp.net';
  await evolution(upsert({ remoteJid: jid, fromMe: false, id: 'ED1' }, { conversation: 'Quero marcar dia 12' }));
  await evolution(upsert({ remoteJid: jid, fromMe: false, id: 'ED2' }, { conversation: 'mensagem errada' }));
  const edit = await evolution(upsert({ remoteJid: jid, fromMe: false, id: 'ED1-EDIT' }, {
    protocolMessage: { key: { id: 'ED1', remoteJid: jid }, type: 'MESSAGE_EDIT', editedMessage: { conversation: 'Quero marcar dia 13' } },
  }, { messageType: 'protocolMessage' }));
  assert.equal(edit.body.recebidas, 0, 'the edit is not a message of its own');
  await evolution(upsert({ remoteJid: jid, fromMe: false, id: 'ED2-DEL' }, { protocolMessage: { key: { id: 'ED2', remoteJid: jid }, type: 0 } }, { messageType: 'protocolMessage' }));
  const rows = (await db.query(`select wa_message_id, body, edited_at is not null as edited, deleted_at is not null as deleted from whatsapp_messages where wa_message_id in ('ED1','ED2') order by 1`)).rows;
  assert.deepEqual(rows.map((r) => [r.body, r.edited, r.deleted]), [['Quero marcar dia 13', true, false], ['mensagem errada', false, true]]);

  await evolution(upsert({ remoteJid: jid, fromMe: true, id: 'ED3' }, { conversation: 'ok' }));
  await evolution({ event: 'MESSAGES_DELETE', instance: 'clinica', data: { id: 'ED3', remoteJid: jid, fromMe: true } });
  assert.equal((await one(db, `select deleted_at is not null as d from whatsapp_messages where wa_message_id = 'ED3'`)).d, true);
});

test('connection drops are recorded, and late messages show up in the health check', async () => {
  await evolution({ event: 'connection.update', instance: 'clinica', data: { instance: 'clinica', state: 'close', statusReason: 428 } });
  await evolution({ event: 'CONNECTION_UPDATE', instance: 'clinica', data: { state: 'open', statusReason: 200 } });
  const events = (await db.query(`select state, reason from whatsapp_connection_events order by id`)).rows;
  assert.deepEqual(events.slice(-2).map((e) => [e.state, e.reason]), [['close', '428'], ['open', '200']]);

  const now = Math.floor(Date.now() / 1000);
  for (const [i, late] of [40, 35, 30].entries()) {
    await evolution(upsert({ remoteJid: '5531955550404@s.whatsapp.net', fromMe: false, id: `HL${i}` }, { conversation: 'oi' }, { messageTimestamp: now - late * 60 }));
  }
  const health = await one(db, `select * from whatsapp_health()`);
  assert.ok(health.delay_minutes >= 39, `delay ${health.delay_minutes}`);
  assert.ok(health.late_messages >= 3);
  assert.equal(health.last_state, 'open');
});

test('a contact seen by its "@lid" id stays in the conversation of its phone', async () => {
  const patient = await createPatient(db, { name: 'Lena Lid', phone: '(31) 97777-3434' });
  // first message only with the anonymous id: its own conversation for now
  await evolution(upsert({ id: 'LD1', remoteJid: '999000111@lid' }, { conversation: 'Oi, é a Lena' }));
  assert.equal((await one(db, `select remote_jid from whatsapp_messages where wa_message_id = 'LD1'`)).remote_jid, '999000111@lid');
  // then one that carries the phone too: both join the phone's conversation
  await evolution(upsert({ id: 'LD2', remoteJid: '999000111@lid', remoteJidAlt: '5531977773434@s.whatsapp.net' }, { conversation: 'Quero marcar' }));
  // and later ones with the anonymous id only follow
  await evolution(upsert({ id: 'LD3', remoteJid: '999000111@lid' }, { conversation: 'Pode ser sexta?' }, { messageTimestamp: 1793000200 }));
  const rows = (await db.query(`select wa_message_id, remote_jid, patient_id from whatsapp_messages where wa_message_id like 'LD%' order by 1`)).rows;
  assert.deepEqual(rows.map((r) => [r.remote_jid, r.patient_id]), Array(3).fill(['5531977773434@s.whatsapp.net', patient]));
  assert.equal((await db.query(`select 1 from whatsapp_conversations where remote_jid = '999000111@lid'`)).rowCount, 0);
});

// ------------------------------------------------------------- no-shows

const faltas = (headers = { authorization: 'Bearer segredo-cron' }) =>
  fetch(`${base}/cron/faltas`, { method: 'POST', headers }).then(async (r) => ({ status: r.status, body: await r.json() }));

// A booking that started `hoursAgo` hours ago, booked a day before it.
async function pastBooking(patient, { hoursAgo = 3, status = 'agendado', agenda = 'Dr. Everson Rezeck', removed = false, createdAfter = false } = {}) {
  return (await one(
    db,
    `insert into appointments (agenda_id, patient_id, starts_at, ends_at, status, created_at, removed_at)
     values ($1, $2, now() - make_interval(mins => $3), now() - make_interval(mins => $3) + interval '30 minutes', $4,
             case when $6 then now() else now() - interval '1 day' - make_interval(mins => $3) end,
             case when $5 then now() end)
     returning id`,
    [await agendaId(db, agenda), patient, Math.round(hoursAgo * 60), status, removed, createdAfter],
  )).id;
}

const noShowsFor = (patient) => received.filter((r) => r.body.tipo === 'falta' && r.body.paciente.id === patient);

test('the no-show endpoint takes the cron secret or the database token, nothing else', async () => {
  assert.equal((await faltas({})).status, 401);
  assert.equal((await faltas({ 'x-cron-token': 'errado' })).status, 401);
  assert.equal((await faltas({ authorization: 'Bearer errado' })).status, 401);
  const { token } = await one(db, `select token from private.internal_tokens where name = 'cron'`);
  assert.equal((await faltas({ 'x-cron-token': token })).status, 200);
  assert.deepEqual((await faltas()).body, { ok: true, faltas: { configurado: false } });
});

test('a patient not marked as arrived 2 hours after the booking is posted once', async () => {
  await setting('no_show_webhook_url', receiverUrl);
  const patient = await createPatient(db, { name: 'Fabio Faltou', phone: '(31) 98765-4400' });
  const appt = await pastBooking(patient, { hoursAgo: 3, status: 'confirmado' });
  const { body } = await faltas();
  assert.equal(body.faltas.configurado, true);
  const mine = noShowsFor(patient);
  assert.equal(mine.length, 1);
  const p = mine[0].body;
  assert.equal(p.agendamento.id, appt);
  assert.equal(p.agendamento.status, 'confirmado');
  assert.equal(p.agendamento.agenda.nome, 'Dr. Everson Rezeck');
  assert.equal(p.agendamento.paciente, undefined, 'the patient is at the top level');
  assert.equal(p.paciente.primeiro_nome, 'Fabio');
  assert.equal(p.paciente.whatsapp, '5531987654400');
  assert.ok(p.minutos_desde_o_horario >= 179 && p.minutos_desde_o_horario <= 182);
  assert.equal(p.tentativa, 1);
  assert.deepEqual(p.agendamentos_futuros, []);
  assert.match(p.resumo, /^Fabio Faltou\./);
  assert.equal(mine[0].signature, `sha256=${createHmac('sha256', 'segredo-assinatura').update(mine[0].raw).digest('hex')}`);
  assert.equal((await one(db, `select status from no_show_alerts where appointment_id = $1`, [appt])).status, 'enviado');

  received = [];
  await faltas();
  await cron();
  assert.equal(noShowsFor(patient).length, 0, 'not sent twice, not even by the daily job');
});

test('arrived, too early, too old, cancelled, removed, typed in later, rebooked or opted out: no post', async () => {
  await setting('no_show_webhook_url', receiverUrl);
  const cases = {
    chegou: await pastBooking(await createPatient(db, { name: 'Chegou Certo', phone: '(31) 98765-4401' }), { status: 'chegou' }),
    cedo: await pastBooking(await createPatient(db, { name: 'Ainda Cedo', phone: '(31) 98765-4402' }), { hoursAgo: 1 }),
    velho: await pastBooking(await createPatient(db, { name: 'Muito Antigo', phone: '(31) 98765-4403' }), { hoursAgo: 30 }),
    cancelado: await pastBooking(await createPatient(db, { name: 'Cancelou Antes', phone: '(31) 98765-4404' }), { status: 'cancelado' }),
    removido: await pastBooking(await createPatient(db, { name: 'Tirado Agenda', phone: '(31) 98765-4405' }), { removed: true }),
    retroativo: await pastBooking(await createPatient(db, { name: 'Lancado Depois', phone: '(31) 98765-4406' }), { createdAfter: true }),
    semAviso: await pastBooking(await createPatient(db, { name: 'Nao Quer', phone: '(31) 98765-4407', allowMessages: false })),
    semTelefone: await pastBooking(await createPatient(db, { name: 'Sem Fone', phone: null })),
  };
  const rebooked = await createPatient(db, { name: 'Ja Remarcou', phone: '(31) 98765-4408' });
  cases.remarcou = await pastBooking(rebooked, { status: 'pediu_remarcar' });
  await pastBooking(rebooked, { hoursAgo: -48 });
  await faltas();
  const ids = new Set(received.filter((r) => r.body.tipo === 'falta').map((r) => r.body.agendamento.id));
  for (const [name, id] of Object.entries(cases)) assert.ok(!ids.has(id), `${name} was posted`);
});

test('"a remarcar" and "não compareceu" still count as a no-show', async () => {
  await setting('no_show_webhook_url', receiverUrl);
  const a = await createPatient(db, { name: 'Remarcar Depois', phone: '(31) 98765-4410' });
  const b = await createPatient(db, { name: 'Nao Veio', phone: '(31) 98765-4411' });
  await pastBooking(a, { status: 'pediu_remarcar' });
  await pastBooking(b, { status: 'nao_compareceu' });
  await faltas();
  assert.equal(noShowsFor(a).length, 1);
  assert.equal(noShowsFor(b).length, 1);
});

test('the delay comes from the settings', async () => {
  await setting('no_show_webhook_url', receiverUrl);
  await setting('no_show_delay_minutes', 30);
  const patient = await createPatient(db, { name: 'Meia Hora', phone: '(31) 98765-4412' });
  await pastBooking(patient, { hoursAgo: 1 });
  await faltas();
  assert.equal(noShowsFor(patient).length, 1);
  await setting('no_show_delay_minutes', 120);
});

test('a failing no-show webhook retries soon; a patient marked as arrived meanwhile is dropped', async () => {
  await setting('no_show_webhook_url', receiverUrl);
  const patient = await createPatient(db, { name: 'Tenta Denovo', phone: '(31) 98765-4413' });
  const appt = await pastBooking(patient);
  failNext = 100;
  await faltas();
  let alert = await one(db, `select * from no_show_alerts where appointment_id = $1`, [appt]);
  assert.equal(alert.status, 'pendente');
  assert.match(alert.last_error, /500/);
  const wait = (alert.next_attempt_at - Date.now()) / 60000;
  assert.ok(wait > 8 && wait <= 10, `retry in ~10 min, got ${wait}`);
  failNext = 0;
  await db.query(`update no_show_alerts set next_attempt_at = now() where id = $1`, [alert.id]);
  await db.query(`update appointments set status = 'chegou' where id = $1`, [appt]);
  received = [];
  await faltas();
  assert.equal(noShowsFor(patient).length, 0);
  alert = await one(db, `select status from no_show_alerts where appointment_id = $1`, [appt]);
  assert.equal(alert.status, 'ignorado');
});

test('the database job calls the server only when the webhook is set and something is due', async () => {
  // Stand-in for pg_net (not installed in the test database).
  await db.query(`create schema if not exists net;
    create table if not exists net.calls (url text, headers jsonb);
    create or replace function net.http_post(url text, body jsonb, headers jsonb, timeout_milliseconds integer) returns bigint
    language sql as $$ insert into net.calls values (url, headers); select 1::bigint $$;
    delete from net.calls;`);
  await setting('no_show_webhook_url', null);
  assert.equal((await one(db, `select ping_no_show_dispatch() as r`)).r, 'não configurado');
  await setting('no_show_webhook_url', receiverUrl);
  await setting('app_url', 'https://clinica.example.com/');
  await faltas(); // drains whatever earlier tests left
  assert.equal((await one(db, `select ping_no_show_dispatch() as r`)).r, 'nada a enviar');
  await pastBooking(await createPatient(db, { name: 'Ping Paciente', phone: '(31) 98765-4414' }));
  assert.equal((await one(db, `select ping_no_show_dispatch() as r`)).r, 'chamado');
  const call = await one(db, `select * from net.calls`);
  assert.equal(call.url, 'https://clinica.example.com/api/cron/faltas');
  const { token } = await one(db, `select token from private.internal_tokens where name = 'cron'`);
  assert.equal(call.headers['x-cron-token'], token);
  assert.equal(token.length, 64);
  await setting('app_url', null);
});
