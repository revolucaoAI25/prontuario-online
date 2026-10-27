import { query, queryOne } from './db.js';
import { ApiError } from './http.js';
import { adminClient } from './supabase-admin.js';

const ROLES = new Set(['admin', 'secretaria', 'profissional']);

function validRole(role) {
  if (!ROLES.has(role)) throw new ApiError(400, 'campo_invalido', 'Papel inválido.', { campo: 'papel' });
  return role;
}

function validPassword(password) {
  if (!password || String(password).length < 8) {
    throw new ApiError(400, 'campo_invalido', 'A senha precisa ter pelo menos 8 caracteres.', { campo: 'senha' });
  }
  return String(password);
}

export async function listUsers() {
  const { data, error } = await adminClient().auth.admin.listUsers({ perPage: 200 });
  if (error) throw error;
  const emails = new Map(data.users.map((u) => [u.id, u.email]));
  const { rows } = await query(
    `select s.*, a.name as agenda_name from staff s left join agendas a on a.id = s.agenda_id order by s.active desc, s.full_name`,
  );
  return { usuarios: rows.map((s) => ({ ...s, email: emails.get(s.id) ?? null })) };
}

export async function createUser(body) {
  const name = String(body.nome ?? '').trim();
  const email = String(body.email ?? '').trim().toLowerCase();
  if (!name) throw new ApiError(400, 'campo_obrigatorio', 'Informe o nome.', { campo: 'nome' });
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new ApiError(400, 'campo_invalido', 'E-mail inválido.', { campo: 'email' });
  const role = validRole(body.papel ?? 'secretaria');
  const password = validPassword(body.senha);

  const { data, error } = await adminClient().auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: name } });
  if (error) {
    if (/already/i.test(error.message)) throw new ApiError(409, 'email_em_uso', 'Já existe um login com esse e-mail.');
    throw error;
  }
  try {
    const staff = await queryOne(
      `insert into staff (id, full_name, role, agenda_id) values ($1, $2, $3, $4) returning *`,
      [data.user.id, name, role, body.agenda_id || null],
    );
    return { usuario: { ...staff, email } };
  } catch (err) {
    await adminClient().auth.admin.deleteUser(data.user.id);
    throw err;
  }
}

export async function updateUser(body, _req, me) {
  const id = String(body.id ?? '');
  const current = await queryOne(`select * from staff where id = $1`, [id]);
  if (!current) throw new ApiError(404, 'usuario_nao_encontrado', 'Usuário não encontrado.');
  const role = body.papel !== undefined ? validRole(body.papel) : current.role;
  const active = body.ativo !== undefined ? Boolean(body.ativo) : current.active;
  if (id === me.id && (role !== 'admin' || !active)) {
    throw new ApiError(400, 'operacao_invalida', 'Você não pode remover o seu próprio acesso de administrador.');
  }
  const staff = await queryOne(
    `update staff set full_name = $2, role = $3, agenda_id = $4, active = $5 where id = $1 returning *`,
    [id, String(body.nome ?? current.full_name).trim() || current.full_name, role, body.agenda_id === undefined ? current.agenda_id : body.agenda_id || null, active],
  );
  return { usuario: staff };
}

export async function resetPassword(body) {
  const { error } = await adminClient().auth.admin.updateUserById(String(body.id ?? ''), { password: validPassword(body.senha) });
  if (error) throw error;
  return {};
}
