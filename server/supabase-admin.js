import { createClient } from '@supabase/supabase-js';
import { queryOne } from './db.js';
import { ApiError } from './http.js';

let client;

export function adminClient() {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set');
    client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return client;
}

// Resolves the logged-in staff member from the request's bearer token.
export async function staffFromRequest(req) {
  const auth = req.headers.authorization || '';
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!token) throw new ApiError(401, 'nao_autorizado', 'Faça login novamente.');
  const { data, error } = await adminClient().auth.getUser(token);
  if (error || !data?.user) throw new ApiError(401, 'nao_autorizado', 'Sessão expirada. Faça login novamente.');
  const staff = await queryOne(`select * from staff where id = $1 and active`, [data.user.id]);
  if (!staff) throw new ApiError(403, 'acesso_negado', 'Usuário sem acesso ao sistema.');
  return staff;
}
