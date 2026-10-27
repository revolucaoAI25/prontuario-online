import { getPool, query, queryOne } from './db.js';
import { ApiError } from './http.js';

const TZ = 'America/Sao_Paulo';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const STATUS_DESCRIPTION = {
  agendado: 'Agendado (aguardando confirmação)',
  confirmado: 'Confirmado pelo paciente',
  chegou: 'Paciente chegou',
  pediu_remarcar: 'Pediu para remarcar',
  nao_compareceu: 'Não compareceu',
  cancelado: 'Cancelado',
};

// ---------------------------------------------------------------- parsing

function invalid(field, message) {
  return new ApiError(400, 'campo_invalido', message, { campo: field });
}

function required(body, field) {
  const value = body[field];
  if (value === undefined || value === null || value === '') {
    throw new ApiError(400, 'campo_obrigatorio', `O campo "${field}" é obrigatório.`, { campo: field });
  }
  return value;
}

// Accepts 2026-11-03 or 03/11/2026.
export function parseDate(value, field = 'data') {
  const text = String(value).trim();
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  let y, m, d;
  if (match) [, y, m, d] = match;
  else if ((match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) [, d, m, y] = match;
  else throw invalid(field, `Data inválida em "${field}". Use AAAA-MM-DD ou DD/MM/AAAA.`);
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(m) - 1 || date.getUTCDate() !== Number(d)) {
    throw invalid(field, `Data inexistente em "${field}".`);
  }
  return date.toISOString().slice(0, 10);
}

// Accepts 09:30, 9:30, 9h30, 9h.
export function parseTime(value, field = 'horario') {
  const match = String(value).trim().toLowerCase().match(/^(\d{1,2})\s*[:h]\s*(\d{2})?$/) ||
    String(value).trim().match(/^(\d{1,2})$/);
  if (!match) throw invalid(field, `Horário inválido em "${field}". Use HH:MM.`);
  const hours = Number(match[1]);
  const minutes = Number(match[2] ?? 0);
  if (hours > 23 || minutes > 59) throw invalid(field, `Horário inválido em "${field}".`);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function parseDuration(value, field = 'duracao_minutos') {
  if (value === undefined || value === null || value === '') return null;
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 600) {
    throw invalid(field, 'A duração deve ser um número inteiro de minutos entre 5 e 600.');
  }
  return minutes;
}

function parseUuid(value, field) {
  if (!UUID_RE.test(String(value ?? ''))) throw invalid(field, `"${field}" precisa ser um id válido.`);
  return String(value);
}

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function dateRange(body, maxDays) {
  if (body.data) {
    const day = parseDate(body.data);
    return [day, day];
  }
  if (body.data_inicio || body.data_fim) {
    const from = parseDate(required(body, 'data_inicio'), 'data_inicio');
    const to = parseDate(required(body, 'data_fim'), 'data_fim');
    if (to < from) throw invalid('data_fim', '"data_fim" deve ser igual ou depois de "data_inicio".');
    if (daysBetween(from, to) >= maxDays) throw invalid('data_fim', `O período pode ter no máximo ${maxDays} dias.`);
    return [from, to];
  }
  throw new ApiError(400, 'campo_obrigatorio', 'Informe "data" ou "data_inicio" e "data_fim".', { campo: 'data' });
}

const asList = (value) => (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]);

// ------------------------------------------------------------- resolution

// An agenda by id or by (part of) its name, ignoring case and accents:
// "everson", "depilação", "Simone Rezeck".
export async function resolveAgenda(value, field = 'agenda') {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  const { rows } = await query(
    `select id, name from agendas
     where active and (id::text = $1 or normalize_text(name) like '%' || normalize_text($1) || '%')
     order by (id::text = $1 or normalize_text(name) = normalize_text($1)) desc, sort_order`,
    [text],
  );
  if (rows.length === 0) {
    throw new ApiError(404, 'agenda_nao_encontrada', `Agenda "${text}" não encontrada.`, { campo: field });
  }
  const exact = rows.filter((r) => r.id === text || r.name.toLowerCase() === text.toLowerCase());
  if (exact.length === 1) return exact[0];
  if (rows.length > 1) {
    throw new ApiError(400, 'agenda_ambigua', `"${text}" corresponde a mais de uma agenda: ${rows.map((r) => r.name).join(', ')}.`, { campo: field });
  }
  return rows[0];
}

async function resolveType(value, agendaId) {
  return (await resolveTypes(value, agendaId))?.[0] ?? null;
}

// Every matching type, best match first; at most one per agenda.
async function resolveTypes(value, agendaId) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  const { rows } = await query(
    `select t.id, t.name, t.agenda_id, t.duration_minutes
     from appointment_types t join agendas a on a.id = t.agenda_id
     where t.active and a.active
       and ($2::uuid is null or t.agenda_id = $2)
       and (t.id::text = $1 or normalize_text(t.name) like '%' || normalize_text($1) || '%')
     order by (t.id::text = $1 or normalize_text(t.name) = normalize_text($1)) desc, a.sort_order, t.sort_order`,
    [text, agendaId],
  );
  if (rows.length === 0) {
    throw new ApiError(400, 'tipo_nao_encontrado', `Tipo de atendimento "${text}" não encontrado${agendaId ? ' nessa agenda' : ''}.`, { campo: 'tipo' });
  }
  const seen = new Set();
  return rows.filter((r) => !seen.has(r.agenda_id) && seen.add(r.agenda_id));
}

// ------------------------------------------------------------- formatting

const APPOINTMENT_SELECT = `
  select a.id, a.agenda_id, ag.name as agenda_name, a.appointment_type_id, t.name as type_name,
         a.patient_id, p.full_name as patient_name, p.phone as patient_phone,
         to_char(a.starts_at at time zone '${TZ}', 'YYYY-MM-DD') as day,
         to_char(a.starts_at at time zone '${TZ}', 'HH24:MI') as start_time,
         to_char(a.ends_at at time zone '${TZ}', 'HH24:MI') as end_time,
         (extract(epoch from a.ends_at - a.starts_at) / 60)::int as duration,
         a.status, a.notes, a.cancel_reason, a.source, a.starts_at,
         coalesce(array_agg(pr.name order by pr.name) filter (where pr.id is not null), '{}') as procedures
  from appointments a
  join agendas ag on ag.id = a.agenda_id
  join patients p on p.id = a.patient_id
  left join appointment_types t on t.id = a.appointment_type_id
  left join appointment_procedures ap on ap.appointment_id = a.id
  left join procedures pr on pr.id = ap.procedure_id`;

const APPOINTMENT_GROUP = `group by a.id, ag.name, ag.sort_order, t.name, p.full_name, p.phone`;

export function formatAppointment(row) {
  return {
    id: row.id,
    agenda: { id: row.agenda_id, nome: row.agenda_name },
    tipo: row.appointment_type_id ? { id: row.appointment_type_id, nome: row.type_name } : null,
    paciente: { id: row.patient_id, nome: row.patient_name, telefone: row.patient_phone },
    data: row.day,
    inicio: row.start_time,
    fim: row.end_time,
    duracao_minutos: row.duration,
    status: row.status,
    status_descricao: STATUS_DESCRIPTION[row.status],
    procedimentos: row.procedures,
    observacao: row.notes,
    motivo_cancelamento: row.cancel_reason,
  };
}

async function loadAppointment(id, client = null) {
  const sql = `${APPOINTMENT_SELECT} where a.id = $1 ${APPOINTMENT_GROUP}`;
  const { rows } = await (client ?? getPool()).query(sql, [id]);
  if (!rows[0]) throw new ApiError(404, 'agendamento_nao_encontrado', 'Agendamento não encontrado.');
  return formatAppointment(rows[0]);
}

function formatPatient(row) {
  return {
    id: row.id,
    nome: row.full_name,
    telefone: row.phone,
    cpf: row.cpf,
    email: row.email,
    data_nascimento: row.birth_date,
  };
}

// --------------------------------------------------------------- actions

export async function listAgendas() {
  const { rows: agendas } = await query(
    `select a.id, a.name,
            coalesce((select json_agg(json_build_object('id', t.id, 'nome', t.name, 'duracao_minutos', t.duration_minutes, 'padrao', t.is_default) order by t.sort_order)
                      from appointment_types t where t.agenda_id = a.id and t.active), '[]') as tipos,
            coalesce((select json_agg(json_build_object('dia_semana', h.weekday, 'inicio', to_char(h.start_time, 'HH24:MI'), 'fim', to_char(h.end_time, 'HH24:MI')) order by h.weekday, h.start_time)
                      from agenda_hours h where h.agenda_id = a.id), '[]') as horarios
     from agendas a where a.active order by a.sort_order, a.name`,
  );
  const { rows: procedures } = await query(
    `select id, name, coalesce(reminder_months, setting_int('default_reminder_months', 6)) as months
     from procedures where active order by name`,
  );
  return {
    agendas: agendas.map((a) => ({ id: a.id, nome: a.name, tipos: a.tipos, horarios: a.horarios })),
    dias_semana: '0 = domingo, 1 = segunda ... 6 = sábado',
    procedimentos: procedures.map((p) => ({ id: p.id, nome: p.name, retorno_meses: p.months })),
  };
}

export async function listAppointments(body) {
  const [from, to] = dateRange(body, 31);
  const agenda = await resolveAgenda(body.agenda);
  const statuses = asList(body.status);
  const includeCancelled = body.incluir_cancelados === true || statuses.includes('cancelado');
  const { rows } = await query(
    `${APPOINTMENT_SELECT}
     where a.starts_at >= local_timestamp($1::date, '00:00')
       and a.starts_at < local_timestamp($2::date + 1, '00:00')
       and ($3::uuid is null or a.agenda_id = $3)
       and ($4::boolean or a.status <> 'cancelado')
       and (cardinality($5::appointment_status[]) = 0 or a.status = any($5::appointment_status[]))
     ${APPOINTMENT_GROUP}
     order by a.starts_at, ag.sort_order`,
    [from, to, agenda?.id ?? null, includeCancelled, statuses],
  );
  return { periodo: { inicio: from, fim: to }, total: rows.length, agendamentos: rows.map(formatAppointment) };
}

export async function availability(body) {
  const [from, to] = dateRange(body, 14);
  const agenda = await resolveAgenda(body.agenda);
  const types = await resolveTypes(body.tipo, agenda?.id ?? null);
  const duration = parseDuration(body.duracao_minutos);
  // (agenda, type) pairs to search: a type name like "consulta" exists in
  // several agendas, so without an agenda each of them is searched.
  const targets = types
    ? (agenda ? types.slice(0, 1) : types).map((t) => [t.agenda_id, t.id])
    : [[agenda?.id ?? null, null]];
  const rows = [];
  for (const [agendaId, typeId] of targets) {
    const result = await query(
      `select s.agenda_id, s.agenda_name, s.appointment_type_id as type_id, d::date::text as day, s.starts_at,
              to_char(s.starts_at at time zone '${TZ}', 'HH24:MI') as start_time,
              (extract(epoch from s.ends_at - s.starts_at) / 60)::int as duration,
              (select sort_order from agendas where id = s.agenda_id) as sort_order
       from generate_series($1::date, $2::date, interval '1 day') d
       cross join lateral available_slots(d::date, $3, $4, $5) s`,
      [from, to, agendaId, typeId, duration],
    );
    rows.push(...result.rows);
  }
  rows.sort((a, b) => a.day.localeCompare(b.day) || a.sort_order - b.sort_order || a.starts_at - b.starts_at);
  const type = types?.[0] ?? null;
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.day}|${row.agenda_id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        data: row.day,
        agenda: { id: row.agenda_id, nome: row.agenda_name },
        tipo_id: row.type_id,
        duracao_minutos: row.duration,
        horarios: [],
      });
    }
    groups.get(key).horarios.push(row.start_time);
  }
  return {
    periodo: { inicio: from, fim: to },
    tipo: type ? { nome: type.name } : null,
    disponibilidade: [...groups.values()],
  };
}

const firstName = (name) => String(name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().split(/\s+/)[0] || '';

// CPF identifies a person. A phone may be shared (a mother booking for her
// daughter), so when a name is given the phone only matches a patient whose
// first name agrees; otherwise a new patient is registered.
async function findPatientMatch(client, patient) {
  const cpf = String(patient.cpf ?? '').replace(/\D/g, '');
  if (cpf.length === 11) {
    const row = (await client.query(`select id from patients where only_digits(cpf) = $1 limit 1`, [cpf])).rows[0];
    if (row) return row.id;
  }
  if (patient.telefone) {
    const { rows } = await client.query(
      `select id, full_name from patients
       where phone_key($1) is not null and (phone_key(phone) = phone_key($1) or phone_key(phone_alt) = phone_key($1))
       order by updated_at desc`,
      [String(patient.telefone)],
    );
    const wanted = firstName(patient.nome);
    const match = wanted ? rows.find((r) => firstName(r.full_name) === wanted) : rows[0];
    if (match) return match.id;
  }
  return null;
}

// Fills only fields the existing record doesn't have yet.
async function completePatient(client, id, patient) {
  await client.query(
    `update patients set
       phone = coalesce(phone, $2), cpf = coalesce(cpf, $3), email = coalesce(email, $4),
       birth_date = coalesce(birth_date, $5::date)
     where id = $1`,
    [id, patient.telefone ?? null, patient.cpf ?? null, patient.email ?? null, patient.data_nascimento ? parseDate(patient.data_nascimento, 'paciente.data_nascimento') : null],
  );
}

async function createPatientRow(client, patient) {
  const name = String(patient.nome ?? '').trim();
  if (!name) {
    throw new ApiError(400, 'campo_obrigatorio', 'Paciente não encontrado: informe "paciente.nome" para cadastrar.', { campo: 'paciente.nome' });
  }
  const row = (await client.query(
    `insert into patients (full_name, phone, cpf, email, birth_date, address, profession, notes)
     values ($1, $2, $3, $4, $5::date, $6, $7, $8) returning *`,
    [
      name,
      patient.telefone ?? null,
      patient.cpf ?? null,
      patient.email ?? null,
      patient.data_nascimento ? parseDate(patient.data_nascimento, 'paciente.data_nascimento') : null,
      patient.endereco ?? null,
      patient.profissao ?? null,
      patient.observacoes ?? null,
    ],
  )).rows[0];
  return row;
}

async function resolvePatientForBooking(client, body) {
  if (body.paciente_id) {
    const id = parseUuid(body.paciente_id, 'paciente_id');
    const row = (await client.query(`select id from patients where id = $1`, [id])).rows[0];
    if (!row) throw new ApiError(404, 'paciente_nao_encontrado', 'Paciente não encontrado.');
    return { id, created: false };
  }
  const patient = body.paciente;
  if (!patient || typeof patient !== 'object') {
    throw new ApiError(400, 'campo_obrigatorio', 'Informe "paciente_id" ou o objeto "paciente" (nome, telefone...).', { campo: 'paciente' });
  }
  const existing = await findPatientMatch(client, patient);
  if (existing) {
    await completePatient(client, existing, patient);
    return { id: existing, created: false };
  }
  return { id: (await createPatientRow(client, patient)).id, created: true };
}

async function inTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function book(body) {
  const agenda = await resolveAgenda(required(body, 'agenda'));
  const type = await resolveType(body.tipo, agenda.id);
  const day = parseDate(required(body, 'data'));
  const time = parseTime(required(body, 'horario'));
  const duration = parseDuration(body.duracao_minutos);
  const procedures = asList(body.procedimentos).map(String).map((p) => p.trim()).filter(Boolean);
  const notes = body.observacao ? String(body.observacao) : null;

  return inTransaction(async (client) => {
    const patient = await resolvePatientForBooking(client, body);
    const start = (await client.query(`select local_timestamp($1::date, $2::time) as ts`, [day, time])).rows[0].ts;
    const end = duration ? new Date(start.getTime() + duration * 60_000) : null;
    const appt = (await client.query(
      `select id from book_appointment(
         p_agenda_id => $1, p_patient_id => $2, p_starts_at => $3, p_ends_at => $4,
         p_appointment_type_id => $5, p_notes => $6, p_procedure_names => $7, p_source => 'api')`,
      [agenda.id, patient.id, start, end, type?.id ?? null, notes, procedures],
    )).rows[0];
    return { paciente_cadastrado: patient.created, agendamento: await loadAppointment(appt.id, client) };
  });
}

export async function confirm(body) {
  const id = parseUuid(required(body, 'agendamento_id'), 'agendamento_id');
  await queryOne(`select confirm_appointment($1)`, [id]);
  return { agendamento: await loadAppointment(id) };
}

export async function cancel(body) {
  const id = parseUuid(required(body, 'agendamento_id'), 'agendamento_id');
  await queryOne(`select cancel_appointment($1, $2)`, [id, body.motivo ? String(body.motivo) : null]);
  return { agendamento: await loadAppointment(id) };
}

export async function reschedule(body) {
  const id = parseUuid(required(body, 'agendamento_id'), 'agendamento_id');
  const day = parseDate(required(body, 'data'));
  const time = parseTime(required(body, 'horario'));
  const duration = parseDuration(body.duracao_minutos);
  const agenda = await resolveAgenda(body.agenda);
  const start = (await queryOne(`select local_timestamp($1::date, $2::time) as ts`, [day, time])).ts;
  const end = duration ? new Date(start.getTime() + duration * 60_000) : null;
  await queryOne(`select reschedule_appointment($1, $2, $3, $4)`, [id, start, end, agenda?.id ?? null]);
  return { agendamento: await loadAppointment(id) };
}

async function upcomingFor(patientIds) {
  if (patientIds.length === 0) return new Map();
  const { rows } = await query(
    `${APPOINTMENT_SELECT}
     where a.patient_id = any($1::uuid[]) and a.starts_at > now() and a.status in ('agendado', 'confirmado', 'pediu_remarcar')
     ${APPOINTMENT_GROUP}
     order by a.starts_at`,
    [patientIds],
  );
  const byPatient = new Map();
  for (const row of rows) {
    if (!byPatient.has(row.patient_id)) byPatient.set(row.patient_id, []);
    byPatient.get(row.patient_id).push(formatAppointment(row));
  }
  return byPatient;
}

export async function findPatients(body) {
  let rows = [];
  if (body.id) {
    rows = (await query(`select * from patients where id = $1`, [parseUuid(body.id, 'id')])).rows;
  } else if (body.telefone) {
    rows = (await query(
      `select * from patients where phone_key($1) is not null
       and (phone_key(phone) = phone_key($1) or phone_key(phone_alt) = phone_key($1)) order by updated_at desc`,
      [String(body.telefone)],
    )).rows;
  } else if (body.cpf) {
    rows = (await query(`select * from patients where only_digits(cpf) = only_digits($1)`, [String(body.cpf)])).rows;
  } else if (body.nome) {
    rows = (await query(`select * from search_patients($1, 10)`, [String(body.nome)])).rows;
  } else {
    throw new ApiError(400, 'campo_obrigatorio', 'Informe "telefone", "cpf", "nome" ou "id".', { campo: 'telefone' });
  }
  const upcoming = await upcomingFor(rows.map((r) => r.id));
  return {
    total: rows.length,
    pacientes: rows.map((r) => ({ ...formatPatient(r), proximos_agendamentos: upcoming.get(r.id) ?? [] })),
  };
}

export async function registerPatient(body) {
  return inTransaction(async (client) => {
    const existing = await findPatientMatch(client, body);
    if (existing) {
      await completePatient(client, existing, body);
      const row = (await client.query(`select * from patients where id = $1`, [existing])).rows[0];
      return { ja_existia: true, paciente: formatPatient(row) };
    }
    return { ja_existia: false, paciente: formatPatient(await createPatientRow(client, body)) };
  });
}
