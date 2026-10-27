import { query } from './db.js';

// Evolution API (v1/v2) webhook events → whatsapp_messages. Only 1:1 chats
// are kept; groups, broadcasts and status updates are ignored. Media is
// copied into Storage right away (WhatsApp's own links expire).
const MESSAGE_EVENTS = new Set(['messages.upsert', 'send.message']);
const UPDATE_EVENTS = new Set(['messages.update']);
const IGNORED_TYPES = new Set(['protocolMessage', 'reactionMessage', 'senderKeyDistributionMessage', 'messageContextInfo', 'editedMessage']);

const MEDIA_TYPES = {
  imageMessage: 'imagem',
  videoMessage: 'video',
  ptvMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'documento',
  documentWithCaptionMessage: 'documento',
  stickerMessage: 'figurinha',
};

// Evolution/Baileys delivery states, by name or number.
const STATUS = {
  ERROR: 'erro', 0: 'erro',
  PENDING: 'pendente', 1: 'pendente',
  SERVER_ACK: 'enviado', 2: 'enviado',
  DELIVERY_ACK: 'entregue', 3: 'entregue',
  READ: 'lido', 4: 'lido',
  PLAYED: 'lido', 5: 'lido',
};

const normalizeEvent = (event) => String(event ?? '').toLowerCase().replace(/_/g, '.');
const asList = (data) => (Array.isArray(data) ? data : data?.messages ?? [data]);

function mediaInfo(message = {}, type) {
  const kind = MEDIA_TYPES[type];
  if (!kind) return null;
  const inner = type === 'documentWithCaptionMessage' ? message[type]?.message?.documentMessage : message[type];
  return {
    kind,
    mime: inner?.mimetype?.split(';')[0] ?? null,
    name: inner?.fileName ?? inner?.title ?? null,
    size: Number(inner?.fileLength?.low ?? inner?.fileLength) || null,
  };
}

function messageText(message = {}) {
  const text =
    message.conversation ??
    message.extendedTextMessage?.text ??
    message.imageMessage?.caption ??
    message.videoMessage?.caption ??
    message.documentMessage?.caption ??
    message.documentWithCaptionMessage?.message?.documentMessage?.caption ??
    message.buttonsResponseMessage?.selectedDisplayText ??
    message.listResponseMessage?.title ??
    message.templateButtonReplyMessage?.selectedDisplayText ??
    null;
  if (text) return text;
  const loc = message.locationMessage ?? message.liveLocationMessage;
  if (loc) {
    const where = [loc.name, loc.address].filter(Boolean).join(' — ');
    return `📍 Localização${where ? `: ${where}` : ''} https://maps.google.com/?q=${loc.degreesLatitude},${loc.degreesLongitude}`;
  }
  if (message.contactMessage) return `👤 Contato: ${message.contactMessage.displayName ?? ''}`.trim();
  if (message.contactsArrayMessage) return `👤 ${message.contactsArrayMessage.contacts?.length ?? ''} contatos`;
  return null;
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
  const out = [];
  for (const item of asList(payload.data)) {
    const key = item?.key;
    const jid = key?.remoteJid;
    if (!key?.id || !jid) continue;
    if (/@g\.us$|@broadcast$|@newsletter$/.test(jid)) continue;
    const message = item.message ?? {};
    const type = item.messageType ?? Object.keys(message).find((k) => k !== 'messageContextInfo') ?? null;
    if (IGNORED_TYPES.has(type)) continue;
    const media = mediaInfo(message, type);
    const timestamp = Number(item.messageTimestamp);
    out.push({
      instance: String(payload.instance ?? payload.instanceName ?? 'default'),
      wa_message_id: key.id,
      remote_jid: jid,
      phone_digits: phoneOf(key),
      from_me: Boolean(key.fromMe),
      push_name: key.fromMe ? null : item.pushName ?? null,
      message_type: type,
      body: messageText(message),
      sent_at: new Date(Number.isFinite(timestamp) && timestamp > 0 ? timestamp * 1000 : Date.now()).toISOString(),
      status: key.fromMe ? STATUS[item.status] ?? 'enviado' : null,
      media,
      raw: item,
    });
  }
  return out;
}

// messages.update → [{ instance, wa_message_id, status }]
export function parseStatusEvent(payload) {
  if (!UPDATE_EVENTS.has(normalizeEvent(payload?.event))) return [];
  const instance = String(payload.instance ?? payload.instanceName ?? 'default');
  const out = [];
  for (const item of asList(payload.data)) {
    const id = item?.keyId ?? item?.key?.id;
    const status = STATUS[item?.status ?? item?.update?.status];
    if (id && status) out.push({ instance, wa_message_id: id, status });
  }
  return out;
}

// Stores a message event. `sentBy` and `media` describe a message sent from
// the system itself (its file is already in Storage); Evolution's webhook for
// the same message may arrive before or after, and the row keeps both.
// Returns the rows whose media still has to be downloaded.
export async function storeEvolutionEvent(payload, { sentBy = null, media = null } = {}) {
  const updates = parseStatusEvent(payload);
  for (const u of updates) {
    await query(
      `update whatsapp_messages set status = $3
       where instance = $1 and wa_message_id = $2 and whatsapp_status_rank($3) > whatsapp_status_rank(status)`,
      [u.instance, u.wa_message_id, u.status],
    );
  }

  const messages = parseEvolutionEvent(payload);
  let stored = 0;
  const pending = [];
  for (const m of messages) {
    const file = media ?? null;
    const { rows } = await query(
      `insert into whatsapp_messages (instance, wa_message_id, remote_jid, phone_digits, patient_id, from_me,
                                      push_name, message_type, body, sent_at, raw, sent_by, status,
                                      media_kind, media_status, media_path, media_mime, media_name, media_size)
       values ($1, $2, $3, $4, match_patient_by_phone($4), $5, $6, $7, $8, $9, $10, $11, $12,
               $13, $14, $15, $16, $17, $18)
       on conflict (instance, wa_message_id) do update set
           sent_by = coalesce(whatsapp_messages.sent_by, excluded.sent_by),
           media_status = case when excluded.media_path is not null then 'ok' else whatsapp_messages.media_status end,
           media_path = coalesce(excluded.media_path, whatsapp_messages.media_path),
           media_mime = coalesce(whatsapp_messages.media_mime, excluded.media_mime),
           media_name = coalesce(whatsapp_messages.media_name, excluded.media_name),
           media_size = coalesce(whatsapp_messages.media_size, excluded.media_size)
       where excluded.sent_by is not null or excluded.media_path is not null
       returning id, (xmax = 0) as inserted, media_status`,
      [
        m.instance, m.wa_message_id, m.remote_jid, m.phone_digits, m.from_me, m.push_name, m.message_type, m.body,
        m.sent_at, m.raw, sentBy, m.status,
        m.media?.kind ?? file?.kind ?? null,
        file ? 'ok' : m.media ? 'pendente' : null,
        file?.path ?? null,
        file?.mime ?? m.media?.mime ?? null,
        file?.name ?? m.media?.name ?? null,
        file?.size ?? m.media?.size ?? null,
      ],
    );
    const row = rows[0];
    if (row?.inserted) stored++;
    if (row?.media_status === 'pendente') pending.push(row.id);
  }
  return { recebidas: messages.length, gravadas: stored, atualizadas: updates.length, midias_pendentes: pending };
}
