import { test, before, after } from 'node:test';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { resetDatabase, connect, TEST_DATABASE_URL } from '../helpers/db.js';
import { createEmulator, SERVICE_ROLE_KEY } from '../../dev/supabase-emulator.mjs';

process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.EVOLUTION_API_KEY = 'chave-global';
process.env.EVOLUTION_INSTANCE = 'clinica-teste';
process.env.EVOLUTION_WEBHOOK_SECRET = 'segredo-webhook';

// Minimal stand-in for an Evolution API v2 server.
const evo = { instances: new Map(), calls: [], mediaFails: true, fetched: null };
const storageDir = mkdtempSync(path.join(tmpdir(), 'storage-'));
const evoServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    evo.calls.push({ method: req.method, url: req.url, body });
    const send = (status, json) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(json)); };
    if (req.headers.apikey !== 'chave-global') return send(401, { message: 'Unauthorized' });
    const [, area, action, name] = req.url.split('/');
    const instance = evo.instances.get(decodeURIComponent(name ?? ''));
    if (area === 'instance' && action === 'create') {
      evo.instances.set(body.instanceName, { state: 'connecting', webhook: body.webhook });
      return send(201, { instance: { instanceName: body.instanceName }, qrcode: { base64: 'data:image/png;base64,QR1', pairingCode: 'ABCD1234' } });
    }
    if (!instance) return send(404, { response: { message: ['instance does not exist'] } });
    if (action === 'connectionState') return send(200, { instance: { state: instance.state } });
    if (action === 'connect') return send(200, { base64: 'data:image/png;base64,QR2', pairingCode: 'EFGH5678' });
    if (area === 'webhook' && action === 'set') { instance.webhook = body.webhook; return send(201, body); }
    if (action === 'logout') { instance.state = 'close'; return send(200, {}); }
    if (area === 'chat' && action === 'getBase64FromMediaMessage') {
      if (body.message.key.id === 'FAILMEDIA' && evo.mediaFails) return send(400, { response: { message: ['Message not found'] } });
      return send(201, { mediaType: 'imageMessage', mimetype: 'image/jpeg', base64: Buffer.from(`jpeg:${body.message.key.id}`).toString('base64') });
    }
    if (area === 'message' && (action === 'sendMedia' || action === 'sendWhatsAppAudio')) {
      fetch(body.media ?? body.audio).then((r) => r.text()).then((t) => { evo.fetched = t; });
      const id = `MSG${evo.calls.length}`;
      const message = action === 'sendMedia'
        ? { [`${body.mediatype}Message`]: { mimetype: body.mimetype, caption: body.caption, fileName: body.fileName } }
        : { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true } };
      return send(201, { key: { remoteJid: `${body.number}@s.whatsapp.net`, fromMe: true, id }, message, messageType: Object.keys(message)[0], messageTimestamp: 1793000000, status: 'PENDING' });
    }
    if (area === 'message' && action === 'sendText') {
      if (body.number === '5531900000000') return send(400, { response: { message: [{ exists: false, number: body.number }] } });
      const id = `MSG${evo.calls.length}`;
      return send(201, {
        key: { remoteJid: `${body.number}@s.whatsapp.net`, fromMe: true, id },
        message: { conversation: body.text }, messageType: 'conversation', messageTimestamp: 1793000000, status: 'PENDING',
      });
    }
    return send(404, {});
  });
}).listen(0);
process.env.EVOLUTION_API_URL = `http://localhost:${evoServer.address().port}/`;

let db;
let emulator;
let api;
let base;
let authUrl;
let closePool;

before(async () => {
  resetDatabase();
  db = await connect();
  await db.query(`
    insert into auth.users (id, email, encrypted_password) values
      ('00000000-0000-0000-0000-0000000000a1', 'admin@t.dev', extensions.crypt('senha123', extensions.gen_salt('bf'))),
      ('00000000-0000-0000-0000-0000000000a2', 'rec@t.dev', extensions.crypt('senha123', extensions.gen_salt('bf'))),
      ('00000000-0000-0000-0000-0000000000a3', 'suporte@t.dev', extensions.crypt('senha123', extensions.gen_salt('bf')));
    insert into staff (id, full_name, role, is_superadmin) values
      ('00000000-0000-0000-0000-0000000000a1', 'Admin', 'admin', false),
      ('00000000-0000-0000-0000-0000000000a2', 'Recepção', 'secretaria', false),
      ('00000000-0000-0000-0000-0000000000a3', 'Suporte', 'admin', true);`);
  emulator = createEmulator({ databaseUrl: TEST_DATABASE_URL, postgrestUrl: 'http://localhost:1', storageDir }).listen(0);
  authUrl = `http://localhost:${emulator.address().port}`;
  process.env.SUPABASE_URL = authUrl;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;
  const { createDevServer } = await import('../../server/dev-server.js');
  ({ closePool } = await import('../../server/db.js'));
  api = createDevServer().listen(0);
  base = `http://localhost:${api.address().port}/api/admin`;
});

after(async () => {
  evoServer.close();
  api.close();
  emulator.close();
  await closePool();
  await db.end();
});

async function login(email, password = 'senha123') {
  const res = await fetch(`${authUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  return (await res.json()).access_token;
}

const call = async (action, body, token) => {
  const res = await fetch(`${base}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json() };
};

test('only a logged-in admin can manage users', async () => {
  assert.equal((await call('usuarios')).status, 401);
  assert.equal((await call('usuarios', {}, await login('rec@t.dev'))).status, 403);
  const { status, body } = await call('usuarios', {}, await login('admin@t.dev'));
  assert.equal(status, 200);
  assert.deepEqual(body.usuarios.map((u) => [u.full_name, u.email]).sort(), [['Admin', 'admin@t.dev'], ['Recepção', 'rec@t.dev'], ['Suporte', 'suporte@t.dev']]);
});

test('admin creates a login that works, and can reset its password', async () => {
  const admin = await login('admin@t.dev');
  const weak = await call('criar_usuario', { nome: 'Amanda', email: 'amanda@t.dev', senha: '123', papel: 'profissional' }, admin);
  assert.equal(weak.body.erro.campo ?? weak.body.erro.detalhes?.campo, 'senha');

  const created = await call('criar_usuario', { nome: 'Amanda', email: 'Amanda@T.dev', senha: 'senhaforte1', papel: 'profissional' }, admin);
  assert.equal(created.status, 200);
  assert.equal(created.body.usuario.role, 'profissional');
  assert.ok(await login('amanda@t.dev', 'senhaforte1'));

  const dup = await call('criar_usuario', { nome: 'Outra', email: 'amanda@t.dev', senha: 'senhaforte1' }, admin);
  assert.equal(dup.body.erro.codigo, 'email_em_uso');

  await call('redefinir_senha', { id: created.body.usuario.id, senha: 'novasenha99' }, admin);
  assert.ok(await login('amanda@t.dev', 'novasenha99'));
});

test('admin cannot remove their own admin access; can deactivate others', async () => {
  const admin = await login('admin@t.dev');
  const self = await call('atualizar_usuario', { id: '00000000-0000-0000-0000-0000000000a1', papel: 'secretaria' }, admin);
  assert.equal(self.body.erro.codigo, 'operacao_invalida');
  const other = await call('atualizar_usuario', { id: '00000000-0000-0000-0000-0000000000a2', ativo: false }, admin);
  assert.equal(other.body.usuario.active, false);
  assert.equal((await call('usuarios', {}, await login('rec@t.dev'))).status, 403, 'deactivated staff lose access');
});

test('the clinic admin cannot edit the support login, create a super admin, or open the WhatsApp panel', async () => {
  const admin = await login('admin@t.dev');
  const support = '00000000-0000-0000-0000-0000000000a3';
  assert.equal((await call('atualizar_usuario', { id: support, papel: 'secretaria' }, admin)).status, 403);
  assert.equal((await call('redefinir_senha', { id: support, senha: 'trocada123' }, admin)).status, 403);
  assert.equal((await call('criar_usuario', { nome: 'X', email: 'x@t.dev', senha: 'senhaforte1', papel: 'admin', super_admin: true }, admin)).status, 403);

  const superToken = await login('suporte@t.dev');
  const created = await call('criar_usuario', { nome: 'Dev 2', email: 'dev2@t.dev', senha: 'senhaforte1', papel: 'admin', super_admin: true }, superToken);
  assert.equal(created.body.usuario.is_superadmin, true);
  assert.equal((await call('atualizar_usuario', { id: support, super_admin: false }, superToken)).body.erro.codigo, 'operacao_invalida', 'cannot drop own super admin');
});

const wa = async (action, body, token) => {
  const res = await fetch(base.replace('/admin', `/whatsapp/${action}`), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json() };
};

test('WhatsApp connection: anyone on the team can show the QR and reconnect; only an admin disconnects', async () => {
  await db.query(`update staff set active = true where id = '00000000-0000-0000-0000-0000000000a2'`);
  const admin = await login('rec@t.dev');
  let status = await wa('status', {}, admin);
  assert.deepEqual(status.body, { ok: true, configurado: true, instancia: 'clinica-teste', existe: false, estado: 'inexistente' });

  const connect = await wa('conectar', {}, admin);
  assert.equal(connect.body.qrcode, 'data:image/png;base64,QR1');
  assert.equal(connect.body.codigo_pareamento, 'ABCD1234');
  const created = evo.instances.get('clinica-teste');
  assert.match(created.webhook.url, /\/api\/webhooks\/evolution\?secret=segredo-webhook$/);
  assert.deepEqual(created.webhook.events, ['MESSAGES_UPSERT', 'SEND_MESSAGE', 'MESSAGES_UPDATE']);

  const again = await wa('conectar', {}, admin);
  assert.equal(again.body.qrcode, 'data:image/png;base64,QR2', 'existing instance: fresh QR, webhook re-applied');
  assert.ok(evo.calls.some((c) => c.url === '/webhook/set/clinica-teste'));

  created.state = 'open';
  status = await wa('status', {}, admin);
  assert.equal(status.body.estado, 'open');
  assert.equal((await wa('conectar', {}, admin)).body.estado, 'open');

  assert.equal((await wa('desconectar', {}, admin)).status, 403, 'reception cannot disconnect');
  assert.equal(created.state, 'open');
  await wa('desconectar', {}, await login('admin@t.dev'));
  assert.equal(created.state, 'close');
});

test('WhatsApp connection: needs a login, and a wrong Evolution key is explained', async () => {
  assert.equal((await wa('status', {})).status, 401);
  process.env.EVOLUTION_API_KEY = 'errada';
  const res = await wa('status', {}, await login('rec@t.dev'));
  assert.equal(res.body.erro.codigo, 'evolution_chave_invalida');
  process.env.EVOLUTION_API_KEY = 'chave-global';
});

const send = async (body, token) => {
  const res = await fetch(base.replace('/admin', '/whatsapp/enviar'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

test('WhatsApp: any staff member can send; the message is stored once, with who sent it', async () => {
  const rec = await login('rec@t.dev');
  await db.query(`update staff set active = true where id = '00000000-0000-0000-0000-0000000000a2'`);
  assert.equal((await send({ telefone: '31987650000', texto: 'Oi' })).status, 401);

  evo.instances.get('clinica-teste').state = 'close';
  assert.equal((await send({ telefone: '31987650000', texto: 'Oi' }, rec)).body.erro.codigo, 'whatsapp_desconectado');
  evo.instances.get('clinica-teste').state = 'open';

  assert.equal((await send({ telefone: '31987650000', texto: '  ' }, rec)).body.erro.codigo, 'campo_obrigatorio');
  assert.equal((await send({ telefone: '(31) 90000-0000', texto: 'Oi' }, rec)).body.erro.codigo, 'numero_sem_whatsapp');

  const patient = (await db.query(`insert into patients (full_name, phone) values ('Paula Envio', '(31) 98765-0000') returning id`)).rows[0].id;
  const sent = await send({ paciente_id: patient, texto: 'Olá, Paula! Tudo bem?' }, rec);
  assert.equal(sent.status, 200);
  assert.deepEqual(evo.calls.at(-1).body, { number: '5531987650000', text: 'Olá, Paula! Tudo bem?' });

  // Evolution's own SEND_MESSAGE webhook for the same message arrives later
  const hook = await fetch(`${base.replace('/admin', '/webhooks/evolution')}?secret=segredo-webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'send.message', instance: 'clinica-teste', data: { key: { remoteJid: '5531987650000@s.whatsapp.net', fromMe: true, id: sent.body.mensagem_id }, message: { conversation: 'Olá, Paula! Tudo bem?' }, messageTimestamp: 1793000000 } }),
  });
  assert.equal(hook.status, 200);
  const { rows } = await db.query(`select m.*, s.full_name as sender from whatsapp_messages m left join staff s on s.id = m.sent_by where m.wa_message_id = $1`, [sent.body.mensagem_id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sender, 'Recepção');
  assert.equal(rows[0].patient_id, patient);
  assert.equal(rows[0].from_me, true);
});

const webhook = (payload) => fetch(`${base.replace('/admin', '/webhooks/evolution')}?secret=segredo-webhook`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
}).then((r) => r.json());
const received = (id, message) => ({
  event: 'messages.upsert', instance: 'clinica-teste',
  data: { key: { remoteJid: '5531966660000@s.whatsapp.net', fromMe: false, id }, pushName: 'Carla', message, messageTimestamp: 1793000000 },
});

test('WhatsApp: received photos are copied into Storage; a failed download can be retried', async () => {
  const res = await webhook(received('IMG1', { imageMessage: { mimetype: 'image/jpeg', caption: 'Foto' } }));
  assert.equal(res.midias, 1);
  const row = (await db.query(`select * from whatsapp_messages where wa_message_id = 'IMG1'`)).rows[0];
  assert.equal(row.media_status, 'ok');
  assert.match(row.media_path, /^whatsapp\/recebidas\/\d{4}-\d{2}\/IMG1\.jpg$/);
  assert.equal(readFileSync(path.join(storageDir, 'prontuario', row.media_path), 'utf8'), 'jpeg:IMG1');

  await webhook(received('FAILMEDIA', { videoMessage: { mimetype: 'video/mp4' } }));
  const failed = (await db.query(`select * from whatsapp_messages where wa_message_id = 'FAILMEDIA'`)).rows[0];
  assert.equal(failed.media_status, 'erro');
  assert.match(failed.media_error, /Message not found/);

  evo.mediaFails = false;
  const rec = await login('rec@t.dev');
  const retry = await fetch(base.replace('/admin', '/whatsapp/midia'), {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${rec}` }, body: JSON.stringify({ id: failed.id }),
  });
  assert.equal(retry.status, 200);
  assert.equal((await db.query(`select media_status from whatsapp_messages where id = $1`, [failed.id])).rows[0].media_status, 'ok');
});

test('WhatsApp: sending a file the browser uploaded, and a voice note', async () => {
  const rec = await login('rec@t.dev');
  const file = 'whatsapp/enviadas/2026-10/abc-orcamento.pdf';
  mkdirSync(path.join(storageDir, 'prontuario', path.dirname(file)), { recursive: true });
  writeFileSync(path.join(storageDir, 'prontuario', file), 'pdf-bytes');

  assert.equal((await send({ telefone: '31966660000', midia: { path: '../segredo', mime: 'application/pdf' } }, rec)).body.erro.codigo, 'campo_invalido');

  const sent = await send({ telefone: '31966660000', texto: 'Segue o orçamento', midia: { path: file, mime: 'application/pdf', nome: 'orcamento.pdf', tamanho: 9 } }, rec);
  assert.equal(sent.status, 200);
  const call = evo.calls.at(-1);
  assert.equal(call.url, '/message/sendMedia/clinica-teste');
  assert.deepEqual([call.body.mediatype, call.body.mimetype, call.body.caption, call.body.fileName], ['document', 'application/pdf', 'Segue o orçamento', 'orcamento.pdf']);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(evo.fetched, 'pdf-bytes', 'Evolution can download the file from the signed link');
  const row = (await db.query(`select * from whatsapp_messages where wa_message_id = $1`, [sent.body.mensagem_id])).rows[0];
  assert.deepEqual([row.media_kind, row.media_status, row.media_path, row.body], ['documento', 'ok', file, 'Segue o orçamento']);

  const voice = 'whatsapp/enviadas/2026-10/audio.webm';
  writeFileSync(path.join(storageDir, 'prontuario', voice), 'opus');
  const audio = await send({ telefone: '31966660000', voz: true, midia: { path: voice, mime: 'audio/webm;codecs=opus' } }, rec);
  assert.equal(audio.status, 200);
  assert.equal(evo.calls.at(-1).url, '/message/sendWhatsAppAudio/clinica-teste');
  const audioRow = (await db.query(`select media_kind, media_path from whatsapp_messages where wa_message_id = $1`, [audio.body.mensagem_id])).rows[0];
  assert.deepEqual([audioRow.media_kind, audioRow.media_path], ['audio', voice]);
  assert.ok(existsSync(path.join(storageDir, 'prontuario', voice)));
});
