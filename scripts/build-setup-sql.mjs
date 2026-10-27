#!/usr/bin/env node
// Builds supabase/setup.sql: every migration plus the seed in one file, to
// paste once into the Supabase SQL Editor. It starts by removing what an
// earlier, failed attempt may have left behind, and refuses to run once the
// database has patients, so it can never wipe real data.
//
//   node scripts/build-setup-sql.mjs          (writes the file)
//   node scripts/build-setup-sql.mjs --check  (fails if it is out of date)
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = `${ROOT}supabase/setup.sql`;
const migrations = readdirSync(`${ROOT}supabase/migrations`).filter((f) => f.endsWith('.sql')).sort();
const sources = migrations.map((f) => [`supabase/migrations/${f}`, readFileSync(`${ROOT}supabase/migrations/${f}`, 'utf8')]);
sources.push(['supabase/seed.sql', readFileSync(`${ROOT}supabase/seed.sql`, 'utf8')]);

const all = sources.map(([, sql]) => sql).join('\n');
const names = (kind) => [...new Set([...all.matchAll(new RegExp(`^create ${kind} (\\w+)`, 'gm'))].map((m) => `public.${m[1]}`))].sort();

const header = `-- =====================================================================
-- Banco da Clínica Rezeck — instalação completa (migrações + dados iniciais)
--
-- Gerado por scripts/build-setup-sql.mjs a partir de supabase/migrations e
-- supabase/seed.sql. Não edite à mão.
--
-- Cole TUDO no SQL Editor do Supabase e clique em Run. Pode rodar de novo se
-- der erro no meio: o começo apaga o que uma tentativa anterior deixou.
-- Se o banco já tiver pacientes, nada é executado (não apaga dados reais).
-- =====================================================================

do $$
declare
    has_patients boolean := false;
begin
    if to_regclass('public.patients') is not null then
        execute 'select exists (select 1 from public.patients)' into has_patients;
    end if;
    if has_patients then
        raise exception 'Este banco já tem pacientes. setup.sql é só para a instalação inicial e não foi executado.';
    end if;
end;
$$;

-- Limpa uma tentativa anterior (só objetos deste sistema, no schema public).
drop view if exists ${names('view').join(', ')} cascade;
drop table if exists ${names('table').join(', ')} cascade;
drop type if exists ${names('type').join(', ')} cascade;
do $$
declare
    r record;
begin
    for r in
        select p.oid::regprocedure as fn
        from pg_proc p
        where p.pronamespace = 'public'::regnamespace
          and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
    loop
        execute 'drop function if exists ' || r.fn || ' cascade';
    end loop;
end;
$$;
`;

const body = sources.map(([file, sql]) => `\n-- ---------------------------------------------------------------------\n-- ${file}\n-- ---------------------------------------------------------------------\n\n${sql.trimEnd()}\n`).join('');
const output = `${header}${body}`;

if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== output) {
    console.error('supabase/setup.sql está desatualizado: rode node scripts/build-setup-sql.mjs');
    process.exit(1);
  }
} else {
  writeFileSync(OUT, output);
  console.log(`supabase/setup.sql: ${migrations.length} migrações + seed`);
}
