import { query } from './db.js';

// Evolution API (v1/v2) message events → whatsapp_messages. Only 1:1 chats
// are kept; groups, broadcasts and status updates are ignored.
const MESSAGE_EVENTS = new Set(['messages.upsert', 'send.message']);

const normalizeEvent = (event) => String(event ?? '').toLowerCase().replace(/_/g, '.');

function messageText(message = {}) {
  return (
    message.conversation ??
    message.extendedTextMessage?.text ??
    message.imageMessage?.caption ??
    message.videoMessage?.caption ??
    message.documentMessage?.caption ??
    message.documentMessage?.fileName ??
    message.documentWithCaptionMessage?.message?.documentMessage?.caption ??
    message.buttonsResponseMessage?.selectedDisplayText ??
    message.listResponseMessage?.title ??
    message.templateButtonReplyMessage?.selectedDisplayText ??
    null
  );
}

// The phone behind a chat: classic JIDs carry it; newer "@lid" ids don't, and
// Evolution then sends it separately.
function phoneOf(key = {}) {
  for (const jid of [key.remoteJid, key.remoteJidAlt, key.senderPn]) {
    if (jid && /@s\.whatsapp\.net$/.test(jid)) return jid.split('@')[0].replace(/\D/g, '');
  }
  return null;
}

export function parseEvolutionEvent(payload) {
  if (!MESSAGE_EVENTS.has(normalizeEvent(payload?.event))) return [];
  const items = Array.isArray(payload.data) ? payload.data : payload.data?.messages ?? [payload.data];
  const out = [];
  for (const item of items) {
    const key = item?.key;
    const jid = key?.remoteJid;
    if (!key?.id || !jid) continue;
    if (/@g\.us$|@broadcast$|@newsletter$/.test(jid)) continue;
    const type = item.messageType ?? Object.keys(item.message ?? {})[0] ?? null;
    if (type === 'protocolMessage' || type === 'reactionMessage' || type === 'senderKeyDistributionMessage') continue;
    const timestamp = Number(item.messageTimestamp);
    out.push({
      instance: String(payload.instance ?? payload.instanceName ?? 'default'),
      wa_message_id: key.id,
      remote_jid: jid,
      phone_digits: phoneOf(key),
      from_me: Boolean(key.fromMe),
      push_name: key.fromMe ? null : item.pushName ?? null,
      message_type: type,
      body: messageText(item.message),
      sent_at: new Date(Number.isFinite(timestamp) && timestamp > 0 ? timestamp * 1000 : Date.now()).toISOString(),
      raw: item,
    });
  }
  return out;
}

export async function storeEvolutionEvent(payload) {
  const messages = parseEvolutionEvent(payload);
  let stored = 0;
  for (const m of messages) {
    const { rowCount } = await query(
      `insert into whatsapp_messages (instance, wa_message_id, remote_jid, phone_digits, patient_id, from_me,
                                      push_name, message_type, body, sent_at, raw)
       values ($1, $2, $3, $4, match_patient_by_phone($4), $5, $6, $7, $8, $9, $10)
       on conflict (instance, wa_message_id) do nothing`,
      [m.instance, m.wa_message_id, m.remote_jid, m.phone_digits, m.from_me, m.push_name, m.message_type, m.body, m.sent_at, m.raw],
    );
    stored += rowCount;
  }
  return { recebidas: messages.length, gravadas: stored };
}
