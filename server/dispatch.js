import { createHmac } from 'node:crypto';
import { query } from './db.js';

const BATCH = 50;
const CONCURRENCY = 5;
const WEBHOOK_TIMEOUT_MS = 10_000;

const isoDay = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : value);

function whatsappNumber(digits) {
  const d = String(digits ?? '').replace(/\D/g, '');
  if (d.length < 10) return null;
  return d.startsWith('55') && d.length >= 12 ? d : `55${d}`;
}

function patientPayload(row) {
  return {
    id: row.patient_id,
    nome: row.patient_name,
    primeiro_nome: String(row.patient_name ?? '').trim().split(/\s+/)[0] ?? '',
    telefone: row.phone,
    whatsapp: whatsappNumber(row.phone_digits),
  };
}

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
async function drain({ claimSql, markSent, markFailed, url, toPayload, deadline }) {
  const result = { enviados: 0, falhas: 0 };
  while (Date.now() < deadline) {
    const { rows } = await query(claimSql, [BATCH]);
    if (rows.length === 0) break;
    await inPool(rows, async (row) => {
      try {
        await postWebhook(url, toPayload(row));
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
      toPayload: (row) => ({
        tipo: 'lembrete_retorno',
        lembrete_id: row.reminder_id,
        paciente: patientPayload(row),
        procedimento: { id: row.procedure_id, nome: row.procedure_name },
        ultimo_atendimento: row.last_done_at ? new Date(row.last_done_at).toISOString().slice(0, 10) : null,
        vencimento: isoDay(row.due_on),
        tentativa: row.attempts,
      }),
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
      toPayload: (row) => ({
        tipo: 'aniversario',
        mensagem_id: row.message_id,
        paciente: patientPayload(row),
        data_nascimento: isoDay(row.birth_date),
        idade: row.age,
        tentativa: row.attempts,
      }),
    })),
  };
}
