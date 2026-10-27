import { query } from './db.js';
import { ApiError } from './http.js';
import { APPOINTMENT_GROUP, APPOINTMENT_SELECT, formatAppointment, parseUuid, upcomingFor } from './scheduling.js';

// What a patient's history looks like at a glance, for the AI agent
// (/api/pacientes/contexto) and for the reminder webhook. Record (prontuário)
// text is never included, only how many entries there are.

const TZ = 'America/Sao_Paulo';
const localDay = (column) => `to_char(${column} at time zone '${TZ}', 'YYYY-MM-DD')`;
const RECENT_LIMIT = 5;

export function whatsappNumber(digits) {
  const d = String(digits ?? '').replace(/\D/g, '');
  if (d.length < 10) return null;
  return d.startsWith('55') && d.length >= 12 ? d : `55${d}`;
}

const brDay = (iso) => (iso ? iso.split('-').reverse().join('/') : '');

function groupBy(rows, key = 'patient_id') {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row[key])) map.set(row[key], []);
    map.get(row[key]).push(row);
  }
  return map;
}

export function formatContactPatient(row) {
  return {
    id: row.id,
    nome: row.full_name,
    primeiro_nome: String(row.full_name ?? '').trim().split(/\s+/)[0] ?? '',
    telefone: row.phone,
    telefone_2: row.phone_alt,
    whatsapp: whatsappNumber(row.phone_digits),
    email: row.email,
    data_nascimento: row.birth_day,
    idade: row.age,
    aceita_mensagens: row.allow_messages,
  };
}

// Visit without the patient block (the context already says who it is).
function visit(row) {
  const { paciente, ...rest } = formatAppointment(row);
  return rest;
}

function summaryText(ctx) {
  const p = ctx.paciente;
  const h = ctx.historico;
  const parts = [`${p.nome}${p.idade != null ? `, ${p.idade} anos` : ''}.`];
  if (h.total_atendimentos === 0) {
    parts.push('Nenhum atendimento realizado na clínica ainda.');
  } else {
    const last = h.ultimo_atendimento;
    const lastProcs = last.procedimentos.length ? ` (${last.procedimentos.join(', ')})` : '';
    parts.push(
      `Paciente desde ${h.primeiro_atendimento.slice(0, 4)}, ${h.total_atendimentos} atendimento(s); ` +
        `último em ${brDay(last.data)} na agenda ${last.agenda.nome}${lastProcs}.`,
    );
  }
  if (h.procedimentos_realizados.length) {
    parts.push(`Procedimentos já feitos: ${h.procedimentos_realizados.map((x) => `${x.nome} (${x.vezes}x, última em ${brDay(x.ultima_vez)})`).join('; ')}.`);
  }
  if (h.faltas) parts.push(`Faltou ${h.faltas} vez(es).`);
  if (ctx.agendamentos_futuros.length) {
    parts.push(`Agendamentos futuros: ${ctx.agendamentos_futuros.map((a) => {
      const what = [a.tipo?.nome, ...a.procedimentos].filter(Boolean).join(', ');
      return `${brDay(a.data)} às ${a.inicio} na agenda ${a.agenda.nome}${what ? ` (${what})` : ''} — ${a.status_descricao.toLowerCase()}`;
    }).join('; ')}.`);
  } else {
    parts.push('Sem agendamentos futuros.');
  }
  if (ctx.retornos_pendentes.length) {
    parts.push(`Retornos previstos: ${ctx.retornos_pendentes.map((r) => `${r.procedimento} em ${brDay(r.previsto_para)}`).join('; ')}.`);
  }
  return parts.join(' ');
}

// Map of patient id → context, for any number of patients in a few queries.
export async function patientContexts(patientIds) {
  const ids = [...new Set(patientIds)];
  if (ids.length === 0) return new Map();

  const [patients, stats, recent, lastVisits, procedures, agendas, reminders, records, upcoming] = await Promise.all([
    query(
      `select p.*, p.birth_date::text as birth_day,
              extract(year from age(clinic_today(), p.birth_date))::int as age
       from patients p where p.id = any($1::uuid[])`,
      [ids],
    ),
    query(
      `select patient_id,
              count(*) filter (where status = 'chegou')::int as visits,
              ${localDay("min(starts_at) filter (where status = 'chegou')")} as first_visit,
              count(*) filter (where status = 'nao_compareceu')::int as no_shows,
              count(*) filter (where status = 'cancelado')::int as cancellations
       from appointments
       where patient_id = any($1::uuid[]) and starts_at <= now()
       group by patient_id`,
      [ids],
    ),
    query(
      `select * from (
         select s.*, row_number() over (partition by s.patient_id order by s.starts_at desc) as rn
         from (${APPOINTMENT_SELECT}
               where a.patient_id = any($1::uuid[]) and a.starts_at <= now() and a.status <> 'cancelado'
               ${APPOINTMENT_GROUP}) s
       ) t where rn <= ${RECENT_LIMIT} order by starts_at desc`,
      [ids],
    ),
    query(
      `select distinct on (s.patient_id) s.* from (${APPOINTMENT_SELECT}
         where a.patient_id = any($1::uuid[]) and a.status = 'chegou' and a.starts_at <= now()
         ${APPOINTMENT_GROUP}) s
       order by s.patient_id, s.starts_at desc`,
      [ids],
    ),
    query(
      `select a.patient_id, pr.name, count(*)::int as times, ${localDay('max(a.starts_at)')} as last_day
       from appointment_procedures ap
       join appointments a on a.id = ap.appointment_id
       join procedures pr on pr.id = ap.procedure_id
       where a.patient_id = any($1::uuid[]) and a.status = 'chegou'
       group by a.patient_id, pr.name
       order by max(a.starts_at) desc`,
      [ids],
    ),
    query(
      `select a.patient_id, ag.name, count(*)::int as visits
       from appointments a join agendas ag on ag.id = a.agenda_id
       where a.patient_id = any($1::uuid[]) and a.status = 'chegou'
       group by a.patient_id, ag.name order by count(*) desc`,
      [ids],
    ),
    query(
      `select r.patient_id, pr.name, ${localDay('r.last_done_at')} as last_day, r.due_on::text as due_day
       from reminders r join procedures pr on pr.id = r.procedure_id
       where r.patient_id = any($1::uuid[]) and r.status = 'pendente'
       order by r.due_on`,
      [ids],
    ),
    query(
      `select patient_id, count(*)::int as entries, ${localDay('max(entry_at)')} as last_day
       from record_entries where patient_id = any($1::uuid[]) group by patient_id`,
      [ids],
    ),
    upcomingFor(ids),
  ]);

  const statsBy = new Map(stats.rows.map((r) => [r.patient_id, r]));
  const lastVisitBy = new Map(lastVisits.rows.map((r) => [r.patient_id, r]));
  const recordsBy = new Map(records.rows.map((r) => [r.patient_id, r]));
  const recentBy = groupBy(recent.rows);
  const proceduresBy = groupBy(procedures.rows);
  const agendasBy = groupBy(agendas.rows);
  const remindersBy = groupBy(reminders.rows);

  const out = new Map();
  for (const row of patients.rows) {
    const s = statsBy.get(row.id);
    const last = lastVisitBy.get(row.id);
    const rec = recordsBy.get(row.id);
    const ctx = {
      paciente: formatContactPatient(row),
      historico: {
        total_atendimentos: s?.visits ?? 0,
        primeiro_atendimento: s?.first_visit ?? null,
        ultimo_atendimento: last ? visit(last) : null,
        faltas: s?.no_shows ?? 0,
        cancelamentos: s?.cancellations ?? 0,
        procedimentos_realizados: (proceduresBy.get(row.id) ?? []).map((x) => ({ nome: x.name, vezes: x.times, ultima_vez: x.last_day })),
        agendas: (agendasBy.get(row.id) ?? []).map((x) => ({ nome: x.name, atendimentos: x.visits })),
        ultimos_agendamentos: (recentBy.get(row.id) ?? []).map(visit),
        prontuario: { anotacoes: rec?.entries ?? 0, ultima_anotacao: rec?.last_day ?? null },
      },
      agendamentos_futuros: (upcoming.get(row.id) ?? []).map(({ paciente, ...a }) => a),
      retornos_pendentes: (remindersBy.get(row.id) ?? []).map((r) => ({ procedimento: r.name, ultima_vez: r.last_day, previsto_para: r.due_day })),
    };
    ctx.resumo = summaryText(ctx);
    out.set(row.id, ctx);
  }
  return out;
}

// POST /api/pacientes/contexto — who is this phone number? Every patient
// registered with it (families often share one), most recently active first.
export async function patientContext(body) {
  let ids;
  if (body.id) {
    ids = [parseUuid(body.id, 'id')];
  } else if (body.telefone) {
    const { rows } = await query(
      `select p.id from patients p
       where phone_key($1) is not null
         and (phone_key(p.phone) = phone_key($1) or phone_key(p.phone_alt) = phone_key($1))
       order by (select max(a.starts_at) from appointments a where a.patient_id = p.id and a.status <> 'cancelado') desc nulls last,
                p.updated_at desc`,
      [String(body.telefone)],
    );
    ids = rows.map((r) => r.id);
  } else {
    throw new ApiError(400, 'campo_obrigatorio', 'Informe "telefone" (ou "id").', { campo: 'telefone' });
  }
  const contexts = await patientContexts(ids);
  const pacientes = ids.map((id) => contexts.get(id)).filter(Boolean);
  return { encontrado: pacientes.length > 0, total: pacientes.length, pacientes };
}
