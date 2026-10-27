import { test, before, after } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { resetDatabase, connect, TEST_DATABASE_URL } from '../helpers/db.js';
import { createEmulator, SERVICE_ROLE_KEY } from '../../dev/supabase-emulator.mjs';

process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.EVOLUTION_API_KEY = 'chave-global';
process.env.EVOLUTION_INSTANCE = 'clinica-teste';
process.env.EVOLUTION_WEBHOOK_SECRET = 'segredo-webhook';

// Minimal stand-in for an Evolution API v2 server.
const evo = { instances: new Map(), calls: [] };
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
      ('00000000-0000-0000-0000-0000000000a2', 'rec@t.dev', extensions.crypt('senha123', extensions.gen_salt('bf')));
    insert into staff (id, full_name, role) values
      ('00000000-0000-0000-0000-0000000000a1', 'Admin', 'admin'),
      ('00000000-0000-0000-0000-0000000000a2', 'Recepção', 'secretaria');`);
  emulator = createEmulator({ databaseUrl: TEST_DATABASE_URL, postgrestUrl: 'http://localhost:1', storageDir: '/tmp' }).listen(0);
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
  assert.deepEqual(body.usuarios.map((u) => [u.full_name, u.email]).sort(), [['Admin', 'admin@t.dev'], ['Recepção', 'rec@t.dev']]);
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

test('WhatsApp panel: creates the instance with our webhook, shows the QR, tracks status', async () => {
  const admin = await login('admin@t.dev');
  let status = await call('whatsapp_status', {}, admin);
  assert.deepEqual(status.body, { ok: true, configurado: true, instancia: 'clinica-teste', existe: false, estado: 'inexistente' });

  const connect = await call('whatsapp_conectar', {}, admin);
  assert.equal(connect.body.qrcode, 'data:image/png;base64,QR1');
  assert.equal(connect.body.codigo_pareamento, 'ABCD1234');
  const created = evo.instances.get('clinica-teste');
  assert.match(created.webhook.url, /\/api\/webhooks\/evolution\?secret=segredo-webhook$/);
  assert.deepEqual(created.webhook.events, ['MESSAGES_UPSERT', 'SEND_MESSAGE']);

  const again = await call('whatsapp_conectar', {}, admin);
  assert.equal(again.body.qrcode, 'data:image/png;base64,QR2', 'existing instance: fresh QR, webhook re-applied');
  assert.ok(evo.calls.some((c) => c.url === '/webhook/set/clinica-teste'));

  created.state = 'open';
  status = await call('whatsapp_status', {}, admin);
  assert.equal(status.body.estado, 'open');
  assert.equal((await call('whatsapp_conectar', {}, admin)).body.estado, 'open');

  await call('whatsapp_desconectar', {}, admin);
  assert.equal(created.state, 'close');
});

test('WhatsApp panel: admin only, and a wrong Evolution key is explained', async () => {
  assert.equal((await call('whatsapp_status', {}, await login('amanda@t.dev', 'novasenha99'))).status, 403);
  process.env.EVOLUTION_API_KEY = 'errada';
  const res = await call('whatsapp_status', {}, await login('admin@t.dev'));
  assert.equal(res.body.erro.codigo, 'evolution_chave_invalida');
  process.env.EVOLUTION_API_KEY = 'chave-global';
});
