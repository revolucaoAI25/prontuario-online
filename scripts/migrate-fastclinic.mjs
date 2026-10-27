#!/usr/bin/env node
// Imports the FastClinic (SQL Server) database into the new Postgres/Supabase
// schema: agendas' opening hours, procedures, patients, record entries,
// appointments (with procedures and statuses) and future agenda blocks.
//
// Run it against a restored backup (scripts/restore_fastclinic_backup.sh):
//   MSSQL_PASSWORD=... DATABASE_URL=postgresql://... node scripts/migrate-fastclinic.mjs
//
// Safe to re-run with a newer backup (the final sync before go-live): rows are
// upserted by their FastClinic id, and rows edited in the new system after
// the previous import are left alone.
import sql from 'mssql';
import pg from 'pg';
import { splitHistory } from './lib/fastclinic-history.mjs';
import { SqlClient, managementApiRunner } from './lib/sql-over-http.mjs';

pg.types.setTypeParser(1082, (v) => v);

const BATCH = Number(process.env.MIGRATE_BATCH || 1000);
const TODAY = new Date();

const AGENDAS = {
  2: { name: 'Dr. Everson Rezeck' },
  3: { name: 'Estética' },
  5: { name: 'Simone Rezeck' },
  6: { name: 'Depilação a laser' },
  4: { name: 'Consultório 3 (antigo)', inactive: true },
  10: { name: 'Consultório 3 (antigo)', inactive: true },
  9: { name: 'Dr. Oromar Moreira Filho (antigo)', inactive: true },
};

// FastClinic "tipos de atendimento" are mostly procedures.
const LEGACY_TYPES = {
  CONSULTA: { kind: 'consulta' },
  'PRIMEIRA CONSULTA': { kind: 'consulta', note: 'Primeira consulta' },
  RETORNO: { kind: 'consulta', note: 'Retorno' },
  AVALIACAO: { kind: 'avaliacao' },
  BOTOX: { procedure: 'Botox' },
  PREENCHIMENTO: { procedure: 'Preenchimento com ácido hialurônico' },
  SPECTRA: { procedure: 'Laser Spectra (melasma)' },
  'LIMPEZA DE PELE': { procedure: 'Limpeza de pele' },
  ULTRAFORMER: { procedure: 'Ultraformer' },
  CRISTAL: { procedure: 'Peeling de cristal' },
  DECAPAGEM: { procedure: 'Decapagem' },
  HIDRATACAO: { procedure: 'Hidratação' },
  'COOL PEEL': { procedure: 'Cool Peel' },
  'PELING QUIMICO': { procedure: 'Peeling químico' },
  DRENAGEM: { procedure: 'Drenagem' },
  EXOSSOMOS: { procedure: 'Exossomos' },
  'GHK COBRE': { procedure: 'GHK Cobre' },
  KYBELLA: { procedure: 'Kybella' },
  PDRN: { procedure: 'PDRN' },
  DEPILACAO: { procedure: 'Depilação a laser' },
};

const plain = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
const clean = (s) => {
  const t = String(s ?? '').replace(/\s+$/g, '').trim();
  return t === '' ? null : t;
};
const titleCase = (s) => s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
const digits = (s) => String(s ?? '').replace(/\D/g, '');

export function mapLegacyType(description) {
  const key = plain(description);
  if (!key) return { kind: 'consulta' };
  if (LEGACY_TYPES[key]) return LEGACY_TYPES[key];
  if (key.startsWith('DEPIL ')) {
    return { procedure: 'Depilação a laser', note: `Área: ${titleCase(String(description).trim().replace(/^depil\s+/i, ''))}` };
  }
  return { procedure: titleCase(String(description).trim()) };
}

function phones(person) {
  const seen = new Set();
  const out = [];
  for (const value of [person.Celular, person.Fone, person.tel_contato]) {
    const text = clean(value);
    const d = digits(text);
    if (!text || d.length < 8 || seen.has(d)) continue;
    seen.add(d);
    out.push(text);
  }
  // Prefer a mobile number (DDD + 9 + 8 digits) as the main phone.
  out.sort((a, b) => Number(/^\d{2}9\d{8}$/.test(digits(b))) - Number(/^\d{2}9\d{8}$/.test(digits(a))));
  return out;
}

function address(p) {
  const street = [clean(p.Endereco), clean(p.numero)].filter(Boolean).join(', ');
  const city = [clean(p.Municipio), clean(p.Uf)].filter(Boolean).join('/');
  const parts = [street, clean(p.complemento), clean(p.Bairro), city, clean(p.Cep)?.replace(/^\D+$/, '')].filter(Boolean);
  return parts.length ? parts.join(' - ') : null;
}

function validBirthDate(value) {
  if (!value) return null;
  const iso = value.toISOString().slice(0, 10);
  return iso > '1901-01-01' && value < TODAY ? iso : null;
}

const isoDay = (d) => (d ? d.toISOString().slice(0, 10) : null);

// Upserts report whether each row was new (xmax = 0) or changed; rows that
// are identical, or were edited in the new system, are skipped entirely.
const RETURNING_KIND = `returning (xmax = 0) as inserted`;
function tally(counts, rows) {
  for (const r of rows) counts[r.inserted ? 'novos' : 'alterados']++;
}

async function inBatches(rows, fn) {
  for (let i = 0; i < rows.length; i += BATCH) {
    await fn(rows.slice(i, i + BATCH));
  }
}

async function tx(client, fn) {
  await client.query('begin');
  try {
    const result = await fn();
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

async function ensureAgendas(pgc) {
  const ids = {};
  for (const [seq, def] of Object.entries(AGENDAS)) {
    const row = await pgc.query(
      `insert into agendas (name, active, sort_order) values ($1, $2, 99)
       on conflict (name) do update set name = excluded.name returning id`,
      [def.name, !def.inactive],
    );
    ids[seq] = row.rows[0].id;
  }
  return ids;
}

// FastClinic stores each agenda's bookable start times per weekday
// (DIA 1 = domingo). They become fixed slot times plus opening windows.
async function importOpeningHours(ms, pgc, agendaIds) {
  const { recordset } = await ms.query(`
    select SEQAGENDA as agenda, DIA as dia, convert(varchar(5), HORARIO, 108) as hora
    from AGENDASHORARIOS
    where SEQAGENDA in (2, 3, 5, 6) and (validade is null or validade >= cast(getdate() as date))
    order by SEQAGENDA, DIA, HORARIO`);
  const byAgendaDay = new Map();
  for (const r of recordset) {
    const key = `${r.agenda}|${r.dia - 1}`;
    if (!byAgendaDay.has(key)) byAgendaDay.set(key, []);
    byAgendaDay.get(key).push(r.hora);
  }
  const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const toTime = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  const skipped = [];
  await tx(pgc, async () => {
    for (const seq of ['2', '3', '5', '6']) {
      const agendaId = agendaIds[seq];
      // A re-import must not undo hours adjusted in the new system.
      const configured = (await pgc.query(`select count(*)::int as n from agenda_slot_times where agenda_id = $1`, [agendaId])).rows[0].n;
      if (configured > 0) {
        skipped.push(AGENDAS[seq].name);
        continue;
      }
      const duration = (await pgc.query(
        `select coalesce((select duration_minutes from appointment_types where agenda_id = $1 and is_default), 30) as d`,
        [agendaId],
      )).rows[0].d;
      await pgc.query(`delete from agenda_hours where agenda_id = $1`, [agendaId]);
      await pgc.query(`delete from agenda_slot_times where agenda_id = $1`, [agendaId]);
      for (const [key, times] of byAgendaDay) {
        const [agenda, weekday] = key.split('|');
        if (agenda !== seq) continue;
        for (const t of times) {
          await pgc.query(`insert into agenda_slot_times (agenda_id, weekday, start_time) values ($1, $2, $3) on conflict do nothing`, [agendaId, weekday, t]);
        }
        // Opening windows: consecutive start times less than 90 min apart.
        let start = toMin(times[0]);
        let last = start;
        for (const t of [...times.slice(1), null]) {
          const m = t === null ? null : toMin(t);
          if (m === null || m - last > 90) {
            await pgc.query(
              `insert into agenda_hours (agenda_id, weekday, start_time, end_time) values ($1, $2, $3, $4)`,
              [agendaId, weekday, toTime(start), toTime(Math.min(last + duration, 23 * 60 + 59))],
            );
            start = m;
          }
          last = m;
        }
      }
    }
  });
  return { horarios: recordset.length, mantidas: skipped };
}

async function importPatients(ms, pgc) {
  const counts = { novos: 0, alterados: 0 };
  const { recordset } = await ms.query(`
    select pe.Seq, pe.Codigo, pe.Nome, pe.Cnpj_cpf, pe.Email, pe.Fone, pe.Celular, pe.tel_contato, pe.profissao,
           pe.nascimento, pe.Endereco, pe.numero, pe.complemento, pe.Bairro, pe.Municipio, pe.Uf, pe.Cep,
           pe.Observacao, pe.datacad, pe.estadocivil, pe.sexo, pe.pai, pe.mae,
           (select top 1 OBITO from PRONTUARIOS p where p.SEQCLIENTE = pe.Seq) as obito
    from Pessoas pe`);
  const rows = recordset
    .filter((p) => clean(p.Nome))
    .map((p) => {
      const [phone, phoneAlt] = phones(p);
      return {
        legacy_id: p.Seq,
        full_name: clean(p.Nome),
        cpf: digits(p.Cnpj_cpf).length >= 11 ? clean(p.Cnpj_cpf) : null,
        email: clean(p.Email)?.includes('@') ? clean(p.Email) : null,
        phone: phone ?? null,
        phone_alt: phoneAlt ?? null,
        profession: clean(p.profissao),
        birth_date: validBirthDate(p.nascimento),
        address: address(p),
        notes: clean(p.Observacao),
        allow_messages: clean(p.obito) !== 'S',
        created_at: p.datacad ? p.datacad.toISOString() : null,
        legacy_raw: {
          codigo: clean(p.Codigo), sexo: clean(p.sexo), estado_civil: clean(p.estadocivil),
          pai: clean(p.pai), mae: clean(p.mae), telefones: phones(p),
        },
      };
    });
  await inBatches(rows, (batch) => pgc.query(
    `insert into patients (legacy_id, full_name, cpf, email, phone, phone_alt, profession, birth_date,
                           address, notes, allow_messages, legacy_raw, created_at, legacy_synced_at)
     select legacy_id, full_name, cpf, email, phone, phone_alt, profession, birth_date,
            address, notes, allow_messages, legacy_raw, coalesce(created_at, now()), now()
     from jsonb_to_recordset($1::jsonb) as x(
       legacy_id int, full_name text, cpf text, email text, phone text, phone_alt text, profession text,
       birth_date date, address text, notes text, allow_messages boolean, legacy_raw jsonb, created_at timestamptz)
     on conflict (legacy_id) do update set
       full_name = excluded.full_name, cpf = excluded.cpf, email = excluded.email, phone = excluded.phone,
       phone_alt = excluded.phone_alt, profession = excluded.profession, birth_date = excluded.birth_date,
       address = excluded.address, notes = excluded.notes, allow_messages = excluded.allow_messages,
       legacy_raw = excluded.legacy_raw, legacy_synced_at = now()
     where patients.updated_at <= patients.legacy_synced_at + interval '5 seconds'
       and (patients.full_name, patients.cpf, patients.email, patients.phone, patients.phone_alt, patients.profession,
            patients.birth_date, patients.address, patients.notes, patients.allow_messages)
           is distinct from
           (excluded.full_name, excluded.cpf, excluded.email, excluded.phone, excluded.phone_alt, excluded.profession,
            excluded.birth_date, excluded.address, excluded.notes, excluded.allow_messages)
     ${RETURNING_KIND}`,
    [JSON.stringify(batch)],
  ).then((r) => tally(counts, r.rows)));
  return { total: rows.length, ...counts };
}

// Each legacy evolution becomes one entry per dated line. Entry ids are
// evolution id * 1000 + position, so a newer backup updates them in place.
async function importRecords(ms, pgc) {
  const counts = { novos: 0, alterados: 0 };
  const { recordset } = await ms.query(`
    select e.SEQ, p.SEQCLIENTE as patient, e.datta, cast(e.HISTORIA as varchar(max)) as historia,
           cast(e.AUXHISTORIA as varchar(max)) as aux, e.historico2
    from PRONTUARIOS_EVOLUCAO e
    join PRONTUARIOS p on p.SEQ = e.SEQPRONTUARIO`);
  const rows = [];
  let chars = 0;
  for (const e of recordset) {
    const entries = splitHistory(e.historia, TODAY);
    const aux = clean(e.aux);
    if (aux && aux.length > (e.historia ?? '').length && !(e.historia ?? '').includes(aux.slice(0, 200))) {
      entries.push({ date: null, content: `Versão anterior do histórico (FastClinic):\n${aux}` });
    }
    if (clean(e.historico2)) entries.push({ date: null, content: clean(e.historico2) });
    const firstDate = entries.find((x) => x.date)?.date ?? isoDay(e.datta) ?? isoDay(TODAY);
    const kept = entries.slice(0, 999);
    if (entries.length > 999) {
      kept[998] = { ...kept[998], content: entries.slice(998).map((x) => x.content).join('\n') };
    }
    kept.forEach((entry, i) => {
      chars += entry.content.length;
      rows.push({
        legacy_id: e.SEQ * 1000 + i,
        patient_legacy_id: e.patient,
        entry_date: entry.date ?? firstDate,
        content: entry.content,
      });
    });
  }
  await inBatches(rows, (batch) => pgc.query(
    `insert into record_entries (legacy_id, patient_id, entry_at, content, legacy_synced_at)
     select x.legacy_id, p.id, local_timestamp(x.entry_date, '12:00'), x.content, now()
     from jsonb_to_recordset($1::jsonb) as x(legacy_id int, patient_legacy_id int, entry_date date, content text)
     join patients p on p.legacy_id = x.patient_legacy_id
     on conflict (legacy_id) do update set
       patient_id = excluded.patient_id, entry_at = excluded.entry_at, content = excluded.content, legacy_synced_at = now()
     where record_entries.updated_at <= record_entries.legacy_synced_at + interval '5 seconds'
       and (record_entries.patient_id, record_entries.entry_at, record_entries.content)
           is distinct from (excluded.patient_id, excluded.entry_at, excluded.content)
     ${RETURNING_KIND}`,
    [JSON.stringify(batch)],
  ).then((r) => tally(counts, r.rows)));
  // Lines that disappeared from a newer backup (an entry index past the end).
  const latest = new Map();
  for (const r of rows) latest.set(Math.floor(r.legacy_id / 1000), Math.max(latest.get(Math.floor(r.legacy_id / 1000)) ?? -1, r.legacy_id % 1000));
  await pgc.query(
    `delete from record_entries r
     using jsonb_each_text($1::jsonb) j
     where r.legacy_id is not null and r.legacy_id / 1000 = j.key::int and r.legacy_id % 1000 > j.value::int
       and r.updated_at <= r.legacy_synced_at + interval '5 seconds'`,
    [JSON.stringify(Object.fromEntries(latest))],
  );
  return { evolutions: recordset.length, entries: rows.length, chars, ...counts };
}

function legacyStatus(a, now) {
  if (a.ATENDIDO === 'S') return 'chegou';
  if (a.DESMARCAR === 'S') return 'cancelado';
  if (a.starts < now) return a.checked_in ? 'chegou' : 'nao_compareceu';
  return a.CONFIRMADO === 'S' ? 'confirmado' : 'agendado';
}

async function importAppointments(ms, pgc, agendaIds) {
  const { recordset } = await ms.query(`
    with ch as (select distinct SEQATENDIMETO as s from CHEGADA)
    select a.SEQ, a.SEQCLIENTE, a.SEQAGENDA, a.CLIENTE,
           convert(varchar(10), a.DATTA, 120) as dia, convert(varchar(5), a.HORARIO, 108) as hora,
           a.CONFIRMADO, a.ATENDIDO, a.DESMARCAR, a.OBSERVACAO, t.DESCRICAO as tipo,
           case when ch.s is null then 0 else 1 end as checked_in
    from ATENDIMENTOS a
    left join TIPOSATENDIMENTO t on t.SEQ = a.SEQTIPOATEND
    left join ch on ch.s = a.SEQ
    where isnull(a.excluido, 'N') <> 'S' and a.DATTA is not null and a.HORARIO is not null`);

  const now = new Date();
  const toUtc = (dia, hora) => new Date(`${dia}T${hora}:00-03:00`);
  const appointments = [];
  const blocks = [];
  let unknownAgenda = 0;
  for (const a of recordset) {
    const agendaId = agendaIds[a.SEQAGENDA];
    if (!agendaId) {
      unknownAgenda++;
      continue;
    }
    const starts = toUtc(a.dia, a.hora);
    if (!a.SEQCLIENTE) {
      // Patient-less rows were how FastClinic blocked time ("NÃO MARCAR",
      // "VIAGEM SIMONE"); only future ones matter.
      if (starts > now) {
        blocks.push({
          legacy_id: a.SEQ, agenda_id: agendaId, day: a.dia, time: a.hora,
          reason: clean(a.OBSERVACAO) ?? clean(a.CLIENTE) ?? 'Bloqueado (FastClinic)',
        });
      }
      continue;
    }
    const mapped = mapLegacyType(a.tipo);
    const notes = [mapped.note, clean(a.OBSERVACAO)].filter(Boolean).join(' · ') || null;
    appointments.push({
      legacy_id: a.SEQ,
      agenda_id: agendaId,
      patient_legacy_id: a.SEQCLIENTE,
      day: a.dia,
      time: a.hora,
      kind: mapped.kind ?? 'consulta',
      procedure: mapped.procedure ?? null,
      status: legacyStatus({ ...a, starts, checked_in: a.checked_in === 1 }, now),
      notes,
    });
  }

  for (const name of new Set(appointments.map((a) => a.procedure).filter(Boolean))) {
    await pgc.query(`select ensure_procedure($1)`, [name]);
  }

  const counts = { novos: 0, alterados: 0 };
  await inBatches(appointments, (batch) => tx(pgc, async () => {
    const { rows } = await pgc.query(
      `with src as (
         select x.*, p.id as patient_id, local_timestamp(x.day, x.time::time) as starts_at
         from jsonb_to_recordset($1::jsonb) as x(legacy_id int, agenda_id uuid, patient_legacy_id int, day date,
                                                time text, kind text, procedure text, status appointment_status, notes text)
         join patients p on p.legacy_id = x.patient_legacy_id
       ),
       typed as (
         select s.*, t.id as type_id, coalesce(t.duration_minutes, 30) as duration
         from src s
         left join lateral (
           select id, duration_minutes from appointment_types
           where agenda_id = s.agenda_id and active
           order by (s.kind = 'avaliacao' and name = 'Avaliação estética') desc, is_default desc
           limit 1
         ) t on true
       )
       insert into appointments (legacy_id, agenda_id, appointment_type_id, patient_id, starts_at, ends_at,
                                 status, notes, source, legacy_synced_at)
       select legacy_id, agenda_id, type_id, patient_id, starts_at, default_end(agenda_id, starts_at, duration),
              status, notes, 'legado', now()
       from typed
       on conflict (legacy_id) do update set
         agenda_id = excluded.agenda_id, appointment_type_id = excluded.appointment_type_id,
         patient_id = excluded.patient_id, starts_at = excluded.starts_at, ends_at = excluded.ends_at,
         status = excluded.status, notes = excluded.notes, legacy_synced_at = now()
       where appointments.updated_at <= appointments.legacy_synced_at + interval '5 seconds'
         and (appointments.agenda_id, appointments.appointment_type_id, appointments.patient_id, appointments.starts_at,
              appointments.ends_at, appointments.status, appointments.notes)
             is distinct from
             (excluded.agenda_id, excluded.appointment_type_id, excluded.patient_id, excluded.starts_at,
              excluded.ends_at, excluded.status, excluded.notes)
       returning id, legacy_id, (xmax = 0) as inserted`,
      [JSON.stringify(batch)],
    );
    tally(counts, rows);
    const procedureByLegacy = new Map(batch.map((b) => [b.legacy_id, b.procedure]));
    const links = rows.map((r) => ({ appointment_id: r.id, procedure: procedureByLegacy.get(r.legacy_id) }));
    await pgc.query(
      `delete from appointment_procedures where appointment_id = any($1::uuid[])`,
      [rows.map((r) => r.id)],
    );
    await pgc.query(
      `insert into appointment_procedures (appointment_id, procedure_id)
       select x.appointment_id, pr.id
       from jsonb_to_recordset($1::jsonb) as x(appointment_id uuid, procedure text)
       join procedures pr on normalize_text(btrim(pr.name)) = normalize_text(btrim(x.procedure))
       on conflict do nothing`,
      [JSON.stringify(links.filter((l) => l.procedure))],
    );
  }));

  // Future bookings and blocks deleted in FastClinic since the last import.
  const exportIds = appointments.map((a) => a.legacy_id);
  const removed = await pgc.query(
    `update appointments
     set status = 'cancelado', cancel_reason = 'Excluído no FastClinic', legacy_synced_at = now()
     where source = 'legado' and legacy_id <> all($1::int[]) and status <> 'cancelado' and starts_at > now()
       and updated_at <= legacy_synced_at + interval '5 seconds'
     returning id`,
    [exportIds],
  );
  await pgc.query(
    `delete from agenda_blocks where legacy_id is not null and legacy_id <> all($1::int[]) and starts_at > now()`,
    [blocks.map((b) => b.legacy_id)],
  );

  await pgc.query(
    `insert into agenda_blocks (legacy_id, agenda_id, starts_at, ends_at, reason)
     select x.legacy_id, x.agenda_id, local_timestamp(x.day, x.time::time),
            local_timestamp(x.day, x.time::time) + make_interval(mins => coalesce(
              (select duration_minutes from appointment_types where agenda_id = x.agenda_id and is_default), 30)),
            x.reason
     from jsonb_to_recordset($1::jsonb) as x(legacy_id int, agenda_id uuid, day date, time text, reason text)
     on conflict (legacy_id) do update set starts_at = excluded.starts_at, ends_at = excluded.ends_at, reason = excluded.reason`,
    [JSON.stringify(blocks)],
  );

  return { source: recordset.length, appointments: appointments.length, ...counts, cancelados: removed.rows.length, blocks: blocks.length, unknownAgenda };
}

// DATABASE_URL (direct Postgres), or SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF
// to go through the Supabase Management API over HTTPS when port 5432/6543
// is not reachable.
function databaseClient() {
  if (process.env.SUPABASE_ACCESS_TOKEN && process.env.SUPABASE_PROJECT_REF) {
    return new SqlClient(managementApiRunner({ token: process.env.SUPABASE_ACCESS_TOKEN, projectRef: process.env.SUPABASE_PROJECT_REF }));
  }
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? '');
  return new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: isLocal ? false : { rejectUnauthorized: false } });
}

export async function main({ pgc = databaseClient() } = {}) {
  const ms = await sql.connect({
    server: process.env.MSSQL_HOST || 'localhost',
    port: Number(process.env.MSSQL_PORT || 1433),
    user: process.env.MSSQL_USER || 'sa',
    password: process.env.MSSQL_PASSWORD,
    database: process.env.MSSQL_DB || 'clinica',
    options: { trustServerCertificate: true, encrypt: false },
    requestTimeout: 600_000,
  });
  await pgc.connect();
  const started = Date.now();
  try {
    const agendaIds = await ensureAgendas(pgc);
    const hours = await importOpeningHours(ms, pgc, agendaIds);
    console.log(`horários das agendas: ${hours.mantidas.length ? `mantidos os já configurados (${hours.mantidas.join(', ')})` : `${hours.horarios} horários fixos importados`}`);
    const pat = await importPatients(ms, pgc);
    console.log(`pacientes: ${pat.total} no FastClinic → ${pat.novos} novos, ${pat.alterados} alterados`);
    const rec = await importRecords(ms, pgc);
    console.log(`prontuários: ${rec.entries} entradas → ${rec.novos} novas, ${rec.alterados} alteradas`);
    const appt = await importAppointments(ms, pgc, agendaIds);
    console.log(`agendamentos: ${appt.appointments} no FastClinic → ${appt.novos} novos, ${appt.alterados} alterados, ${appt.cancelados} cancelados (excluídos lá); ${appt.blocks} bloqueios futuros`);
    console.log('Registros editados no sistema novo depois da última importação não são alterados.');
    console.log(`concluído em ${Math.round((Date.now() - started) / 1000)}s`);
  } finally {
    await pgc.end();
    await ms.close();
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
