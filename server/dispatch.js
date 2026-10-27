import { createHmac } from 'node:crypto';
import { query } from './db.js';
import { APPOINTMENT_GROUP, APPOINTMENT_SELECT, formatAppointment } from './scheduling.js';
import { patientContexts } from './patient-context.js';

const BATCH = 50;
const CONCURRENCY = 5;
const WEBHOOK_TIMEOUT_MS = 10_000;

const isoDay = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : value);
const TZ = 'America/Sao_Paulo';

async function settingUrl(key) {
  const { rows } = await query(`select setting_text($1) as v`, [key]);
  const url = rows[0]?.v;
  return url && /^https?:\/\//.test(url) ? url : null;
}

// POSTs JSON to the configured webhook. A receiver can check the
// x-clinica-assinatura header (HMAC-SHA256 of the body) when
// WEBHOOK_SIGNING_SECRET is set.
async function postWebhook(url, payload) {
  const body = JSON.stringify(payload);
  const headers = { 'content-type': 'application/json' };
  if (process.env.WEBHOOK_SIGNING_SECRET) {
    headers['x-clinica-assinatura'] = `sha256=${createHmac('sha256', process.env.WEBHOOK_SIGNING_SECRET).update(body).digest('hex')}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
    if (!res.ok) throw new Error(`webhook respondeu ${res.status}`);
  } catch (error) {
    throw new Error(error.name === 'AbortError' ? 'webhook não respondeu em 10s' : error.message);
  } finally {
    clearTimeout(timer);
  }
}

async function inPool(items, fn) {
  let index = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

// Claims due items in batches (the database leases them, so overlapping runs
// never double-send) until the queue is empty or the time budget runs out.
async function drain({ claimSql, markSent, markFailed, url, enrich, toPayload, deadline }) {
  const result = { enviados: 0, falhas: 0 };
  while (Date.now() < deadline) {
    const { rows } = await query(claimSql, [BATCH]);
    if (rows.length === 0) break;
    const extras = await enrich(rows);
    await inPool(rows, async (row) => {
      try {
        await postWebhook(url, toPayload(row, extras));
        await query(markSent, [row.id]);
        result.enviados++;
      } catch (error) {
        await query(markFailed, [row.id, error.message]);
        result.falhas++;
      }
    });
    if (rows.length < BATCH) break;
  }
  return result;
}

// Everything the message flow may want to mention: who, which procedure,
// when it was last done (and in which visit), when the return is due, the
// rest of the patient's history and anything already booked.
async function reminderExtras(rows) {
  const ids = rows.map((r) => r.reminder_id);
  const [contexts, details, visits] = await Promise.all([
    patientContexts(rows.map((r) => r.patient_id)),
    query(
      `select r.id, r.created_manually, r.notes, r.source_appointment_id,
              reminder_months_for(r.procedure_id) as months,
              to_char(r.last_done_at at time zone '${TZ}', 'YYYY-MM-DD') as last_day,
              (clinic_today() - (r.last_done_at at time zone '${TZ}')::date) as days_since,
              (select count(*)::int from appointment_procedures ap join appointments a on a.id = ap.appointment_id
               where a.patient_id = r.patient_id and ap.procedure_id = r.procedure_id and a.status = 'chegou') as times
       from reminders r where r.id = any($1::uuid[])`,
      [ids],
    ),
    query(
      `${APPOINTMENT_SELECT}
       where a.id in (select source_appointment_id from reminders where id = any($1::uuid[]))
       ${APPOINTMENT_GROUP}`,
      [ids],
    ),
  ]);
  return {
    contexts,
    details: new Map(details.rows.map((r) => [r.id, r])),
    visits: new Map(visits.rows.map((r) => [r.id, r])),
  };
}

function reminderPayload(row, { contexts, details, visits }) {
  const ctx = contexts.get(row.patient_id);
  const d = details.get(row.reminder_id) ?? {};
  const source = visits.get(d.source_appointment_id);
  let atendimento = null;
  if (source) {
    const { paciente, ...rest } = formatAppointment(source);
    atendimento = rest;
  }
  return {
    tipo: 'lembrete_retorno',
    lembrete_id: row.reminder_id,
    tentativa: row.attempts,
    paciente: ctx.paciente,
    procedimento: { id: row.procedure_id, nome: row.procedure_name, retorno_em_meses: d.months ?? null },
    data_ultima_vez: d.last_day ?? null,
    dias_desde_ultima_vez: d.days_since ?? null,
    vezes_que_fez: d.times ?? 0,
    data_retorno_prevista: isoDay(row.due_on),
    atendimento_de_origem: atendimento,
    criado_manualmente: Boolean(d.created_manually),
    observacao: d.notes ?? null,
    outros_retornos_pendentes: ctx.retornos_pendentes.filter((r) => r.procedimento !== row.procedure_name),
    agendamentos_futuros: ctx.agendamentos_futuros,
    historico: ctx.historico,
    resumo: ctx.resumo,
  };
}

export async function dispatchReminders({ deadline = Date.now() + 25_000 } = {}) {
  const url = await settingUrl('reminder_webhook_url');
  if (!url) return { configurado: false };
  return {
    configurado: true,
    ...(await drain({
      url,
      deadline,
      claimSql: `select reminder_id as id, * from claim_due_reminders($1)`,
      markSent: `select mark_reminder_sent($1)`,
      markFailed: `select mark_reminder_failed($1, $2)`,
      enrich: reminderExtras,
      toPayload: reminderPayload,
    })),
  };
}

export async function dispatchBirthdays({ deadline = Date.now() + 25_000 } = {}) {
  const url = await settingUrl('birthday_webhook_url');
  if (!url) return { configurado: false };
  return {
    configurado: true,
    ...(await drain({
      url,
      deadline,
      claimSql: `select message_id as id, * from claim_birthdays($1)`,
      markSent: `select mark_birthday_sent($1)`,
      markFailed: `select mark_birthday_failed($1, $2)`,
      enrich: async (rows) => ({ contexts: await patientContexts(rows.map((r) => r.patient_id)) }),
      toPayload: (row, { contexts }) => {
        const ctx = contexts.get(row.patient_id);
        return {
          tipo: 'aniversario',
          mensagem_id: row.message_id,
          paciente: ctx.paciente,
          data_nascimento: isoDay(row.birth_date),
          idade: row.age,
          agendamentos_futuros: ctx.agendamentos_futuros,
          tentativa: row.attempts,
        };
      },
    })),
  };
}
