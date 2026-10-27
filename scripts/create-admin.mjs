#!/usr/bin/env node
// Creates the first login (administrator). Later logins are created in the
// app under Ajustes → Usuários.
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... DATABASE_URL=... \
//   node scripts/create-admin.mjs "Dr. Everson Rezeck" everson@exemplo.com "senha-forte" "Dr. Everson Rezeck"
//
// The last argument (agenda name) is optional. Add --super for the agency's
// login (super admin: also configures webhooks and the WhatsApp connection).
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

const superadmin = process.argv.includes('--super');
const [name, email, password, agendaName] = process.argv.slice(2).filter((a) => a !== '--super');
if (!name || !email || !password || password.length < 8) {
  console.error('Uso: node scripts/create-admin.mjs "Nome" email senha(>=8) ["Nome da agenda"]');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? '');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: isLocal ? false : { rejectUnauthorized: false } });

const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: name } });
if (error) {
  console.error(`Erro ao criar login: ${error.message}`);
  process.exit(1);
}
await db.connect();
await db.query(
  `insert into staff (id, full_name, role, agenda_id, is_superadmin) values ($1, $2, 'admin', (select id from agendas where name = $3), $4)`,
  [data.user.id, name, agendaName ?? null, superadmin],
);
await db.end();
console.log(`${superadmin ? 'Super admin' : 'Administrador'} criado: ${email}`);
