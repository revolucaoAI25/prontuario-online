import { createHmac, timingSafeEqual } from 'node:crypto';
import { query } from './db.js';
import { APPOINTMENT_GROUP, APPOINTMENT_SELECT, formatAppointment } from './scheduling.js';
import { patientContexts } from './patient-context.js';
import { birthdayPayload, campaignPayload, noShowPayload, reminderPayload } from './webhook-payloads.js';

const BATCH = 50;
const CONCURRENCY = 5;
const WEBHOOK_TIMEOUT_MS = 10_000;
// Campaign webhooks often run an assistant before answering (e.g. Chatflux).
export const campaignTimeoutMs = () => Number(process.env.CAMPAIGN_WEBHOOK_TIMEOUT_MS) || 30_000;

const TZ = 'America/Sao_Paulo';

async function settingUrl(key) {
  const { rows } = await query(`select setting_text($1) as v`, [key]);
  const url = rows[0]?.v;
  return url && /^https?:\/\//.test(url) ? url : null;
}

// POSTs JSON to the configured webhook. A receiver can check the
// x-clinica-assinatura header (HMAC-SHA256 of the body) when
// WEBHOOK_SIGNING_SECRET is set.
// Returns { status, ms, body }. A webhook that doesn't answer in time may
// still have received the message: that error carries `uncertain`.
export async function postWebhook(url, payload, { timeoutMs = WEBHOOK_TIMEOUT_MS } = {}) {
  const body = JSON.stringify(payload);
  const headers = { 'content-type': 'application/json' };
  if (process.env.WEBHOOK_SIGNING_SECRET) {
    headers['x-clinica-assinatura'] = `sha256=${createHmac('sha256', process.env.WEBHOOK_SIGNING_SECRET).update(body).digest('hex')}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
    const text = await res.text().catch(() => '');
    const result = { status: res.status, ms: Date.now() - started, body: text.slice(0, 2000) };
    if (!res.ok) throw Object.assign(new Error(`webhook respondeu ${res.status}`), result);
    return result;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw Object.assign(new Error(`webhook não respondeu em ${Math.round(timeoutMs / 1000)}s`), { uncertain: true, ms: Date.now() - started });
    }
    if (error.status) throw error;
    const code = error.cause?.code ?? error.cause?.errors?.[0]?.code;
    const reason = {
      ENOTFOUND: 'endereço do webhook não encontrado (confira o domínio)',
      ECONNREFUSED: 'nada respondendo nesse endereço',
      ECONNRESET: 'o webhook fechou a conexão',
      CERT_HAS_EXPIRED: 'certificado do webhook vencido',
    }[code] ?? (code ? `falha de conexão (${code})` : error.message === 'fetch failed' ? 'não foi possível conectar ao webhook' : error.message);
    throw Object.assign(new Error(reason), { ms: Date.now() - started });
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
  const [contexts, details] = await Promise.all([
    patientContexts(rows.map((r) => r.patient_id)),
    query(
      `select r.id, r.created_manually, r.notes,
              reminder_months_for(r.procedure_id) as months,
              to_char(r.last_done_at at time zone '${TZ}', 'YYYY-MM-DD') as last_day,
              (clinic_today() - (r.last_done_at at time zone '${TZ}')::date) as days_since,
              (select count(*)::int from appointment_procedures ap join appointments a on a.id = ap.appointment_id
               where a.patient_id = r.patient_id and ap.procedure_id = r.procedure_id and a.status = 'chegou') as times
       from reminders r where r.id = any($1::uuid[])`,
      [ids],
    ),
  ]);
  return { contexts, details: new Map(details.rows.map((r) => [r.id, r])) };
}

function reminderToPayload(row, { contexts, details }, imageUrl) {
  const d = details.get(row.reminder_id) ?? {};
  return reminderPayload({
    imageUrl,
    ctx: contexts.get(row.patient_id),
    r: {
      id: row.reminder_id, attempts: row.attempts, procedure: row.procedure_name, months: d.months,
      lastDay: d.last_day, daysSince: d.days_since, times: d.times, dueOn: row.due_on, notes: d.notes, manual: d.created_manually,
    },
  });
}

export async function dispatchReminders({ deadline = Date.now() + 25_000 } = {}) {
  const [url, imageUrl] = await Promise.all([settingUrl('reminder_webhook_url'), settingUrl('reminder_image_url')]);
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
      toPayload: (row, extras) => reminderToPayload(row, extras, imageUrl),
    })),
  };
}

export async function dispatchBirthdays({ deadline = Date.now() + 25_000 } = {}) {
  const [url, imageUrl] = await Promise.all([settingUrl('birthday_webhook_url'), settingUrl('birthday_image_url')]);
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
      toPayload: (row, { contexts }) => birthdayPayload({
        imageUrl,
        ctx: contexts.get(row.patient_id),
        b: { id: row.message_id, attempts: row.attempts, birthDate: row.birth_date, age: row.age },
      }),
    })),
  };
}

// No-shows: a booking that started a while ago (2 hours by default) and was
// never marked as "chegou". One POST per booking.
async function noShowExtras(rows) {
  const [contexts, appts] = await Promise.all([
    patientContexts(rows.map((r) => r.patient_id)),
    query(`${APPOINTMENT_SELECT} where a.id = any($1::uuid[]) ${APPOINTMENT_GROUP}`, [rows.map((r) => r.appointment_id)]),
  ]);
  return { contexts, appts: new Map(appts.rows.map((r) => [r.id, r])) };
}

function noShowToPayload(row, { contexts, appts }, imageUrl) {
  const { paciente, ...appointment } = formatAppointment(appts.get(row.appointment_id));
  return noShowPayload({
    imageUrl,
    ctx: contexts.get(row.patient_id),
    n: { id: row.alert_id, attempts: row.attempts, minutesLate: row.minutes_late, appointment },
  });
}

export async function dispatchNoShows({ deadline = Date.now() + 25_000 } = {}) {
  const [url, imageUrl] = await Promise.all([settingUrl('no_show_webhook_url'), settingUrl('no_show_image_url')]);
  if (!url) return { configurado: false };
  return {
    configurado: true,
    ...(await drain({
      url,
      deadline,
      claimSql: `select alert_id as id, * from claim_no_shows($1)`,
      markSent: `select mark_no_show_sent($1)`,
      markFailed: `select mark_no_show_failed($1, $2)`,
      enrich: noShowExtras,
      toPayload: (row, extras) => noShowToPayload(row, extras, imageUrl),
    })),
  };
}

// The database job's token (private.internal_tokens), compared in constant time.
export async function isDatabaseCronToken(token) {
  if (!token || typeof token !== 'string') return false;
  const { rows } = await query(`select token from private.internal_tokens where name = 'cron'`);
  const expected = rows[0]?.token;
  if (!expected || expected.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(token));
}

// Campaigns ("Disparos"): each claimed message goes to its campaign's own
// webhook. The database keeps the pace (one message per campaign per claim).
export async function dispatchCampaigns({ deadline = Date.now() + 50_000 } = {}) {
  const result = { enviados: 0, falhas: 0 };
  while (Date.now() < deadline) {
    const { rows } = await query(`select * from claim_campaign_messages()`);
    if (rows.length === 0) break;
    const [contexts, images] = await Promise.all([
      patientContexts(rows.map((r) => r.patient_id)),
      // (an image never holds a send back: before the column exists, none)
      query(`select id, image_url from campaigns where id = any($1::uuid[])`, [[...new Set(rows.map((r) => r.campaign_id))]])
        .catch(() => ({ rows: [] })),
    ]);
    const imageOf = new Map(images.rows.map((c) => [c.id, c.image_url]));
    await inPool(rows, async (row) => {
      const ctx = contexts.get(row.patient_id);
      try {
        if (!ctx) throw new Error('paciente não encontrado');
        await postWebhook(row.webhook_url, campaignPayload({
          campaign: { id: row.campaign_id, name: row.campaign_name, message: row.campaign_message, imageUrl: imageOf.get(row.campaign_id) },
          recipientId: row.recipient_id,
          attempt: row.attempts,
          ctx,
        }), { timeoutMs: campaignTimeoutMs() });
        await query(`select mark_campaign_sent($1)`, [row.recipient_id]);
        result.enviados++;
      } catch (error) {
        if (error.uncertain) {
          // The webhook took the message but didn't answer in time (some,
          // like Chatflux, only answer after running their actions, or
          // never). Counted as sent, without confirmation; never sent
          // again, so the patient doesn't get it twice.
          await query(`select mark_campaign_unconfirmed($1, $2)`, [row.recipient_id, `${error.message}; enviado sem confirmação`]);
          result.enviados++;
        } else {
          await query(`select mark_campaign_failed($1, $2)`, [row.recipient_id, error.message]);
          result.falhas++;
        }
      }
    });
  }
  return result;
}
