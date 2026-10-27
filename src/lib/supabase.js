import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

// Unwraps a supabase-js response, throwing on error.
export async function must(request) {
  const { data, error } = await request;
  if (error) throw error;
  return data;
}

// Calls one of our own /api functions with the logged-in user's token.
export async function callApi(path, body) {
  const { data } = await supabase.auth.getSession();
  const res = await fetch(`/api/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${data.session?.access_token ?? ''}` },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) throw new Error(json.erro?.mensagem || `Erro ${res.status}`);
  return json;
}
