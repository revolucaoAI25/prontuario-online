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
