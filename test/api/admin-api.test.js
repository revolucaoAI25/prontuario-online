import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, connect, TEST_DATABASE_URL } from '../helpers/db.js';
import { createEmulator, SERVICE_ROLE_KEY } from '../../dev/supabase-emulator.mjs';

process.env.DATABASE_URL = TEST_DATABASE_URL;

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
