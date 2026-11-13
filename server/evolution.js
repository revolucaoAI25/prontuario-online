import { query } from './db.js';

// Evolution API (v1/v2) webhook events → whatsapp_messages. Only 1:1 chats
// are kept; groups, broadcasts and status updates are ignored. Media is
// copied into Storage right away (WhatsApp's own links expire).
const MESSAGE_EVENTS = new Set(['messages.upsert', 'send.message', 'messages.set', 'messages.edited']);
const UPDATE_EVENTS = new Set(['messages.update']);
const DELETE_EVENTS = new Set(['messages.delete']);
const CONNECTION_EVENTS = new Set(['connection.update']);
// Nothing to show: reactions, receipts, poll votes, pins, and the encrypted
// edit/event replies newer phones send (secretEncryptedMessage).
const IGNORED_TYPES = new Set([
  'reactionMessage', 'encReactionMessage', 'senderKeyDistributionMessage', 'messageContextInfo',
  'secretEncryptedMessage', 'encEventResponseMessage', 'pollUpdateMessage', 'keepInChatMessage',
  'pinInChatMessage', 'deviceSentMessage', 'callLogMesssage', 'callLogMessage',
]);

// Envelopes that only wrap the real message (disappearing chats, view once,
// albums, animated stickers, captioned documents...).
const WRAPPERS = [
  'ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension',
  'documentWithCaptionMessage', 'associatedChildMessage', 'lottieStickerMessage', 'botInvokeMessage',
  'groupMentionedMessage', 'futureProofMessage', 'editedMessage',
];

const MEDIA_TYPES = {
  imageMessage: 'imagem',
  videoMessage: 'video',
  ptvMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'documento',
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
const contentKey = (message) => Object.keys(message ?? {}).find((k) => k !== 'messageContextInfo') ?? null;

function unwrap(message = {}) {
  let current = message ?? {};
  for (let i = 0; i < 5; i++) {
    const key = contentKey(current);
    if (!WRAPPERS.includes(key) || !current[key]?.message) break;
    current = current[key].message;
  }
  return current;
}

function mediaInfo(message = {}, type) {
  const kind = MEDIA_TYPES[type];
  if (!kind) return null;
  const inner = message[type];
  return {
    kind,
    mime: inner?.mimetype?.split(';')[0] ?? null,
    name: inner?.fileName ?? inner?.title ?? null,
    size: Number(inner?.fileLength?.low ?? inner?.fileLength) || null,
  };
}

function messageText(message = {}) {
  const template = message.templateMessage?.hydratedTemplate ?? message.templateMessage?.hydratedFourRowTemplate;
  const text =
    message.conversation ??
    message.extendedTextMessage?.text ??
    message.imageMessage?.caption ??
    message.videoMessage?.caption ??
    message.documentMessage?.caption ??
    message.buttonsResponseMessage?.selectedDisplayText ??
    message.listResponseMessage?.title ??
    message.templateButtonReplyMessage?.selectedDisplayText ??
    message.interactiveResponseMessage?.body?.text ??
    message.buttonsMessage?.contentText ??
    message.interactiveMessage?.body?.text ??
    message.listMessage?.description ??
    (template ? [template.hydratedTitleText, template.hydratedContentText, template.hydratedFooterText].filter(Boolean).join('\n') : null) ??
    null;
  if (text) return text;
  const loc = message.locationMessage ?? message.liveLocationMessage;
  if (loc) {
    const where = [loc.name, loc.address].filter(Boolean).join(' — ');
    return `📍 Localização${where ? `: ${where}` : ''} https://maps.google.com/?q=${loc.degreesLatitude},${loc.degreesLongitude}`;
  }
  if (message.contactMessage) return `👤 Contato: ${message.contactMessage.displayName ?? ''}`.trim();
  if (message.contactsArrayMessage) return `👤 ${message.contactsArrayMessage.contacts?.length ?? ''} contatos`;
  const poll = message.pollCreationMessage ?? message.pollCreationMessageV2 ?? message.pollCreationMessageV3;
  if (poll) return `📊 Enquete: ${poll.name ?? ''}`.trim();
  if (message.eventMessage) return `📅 Evento: ${message.eventMessage.name ?? ''}`.trim();
  if (message.interactiveMessage || message.templateMessage || message.buttonsMessage || message.listMessage) {
    return 'Mensagem com botões (abra no celular para ver as opções)';
  }
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

// Edits and deletions travel as a "protocol" message pointing at another one.
//   → { instance, wa_message_id, edited_body } or { instance, wa_message_id, deleted: true }
function protocolChange(instance, item) {
  const proto = unwrap(item?.message ?? {}).protocolMessage;
  if (!proto?.key?.id) return null;
  const type = proto.type;
  if (type === 0 || type === 'REVOKE') return { instance, wa_message_id: proto.key.id, deleted: true };
  if (type === 14 || type === 'MESSAGE_EDIT') {
    const edited = unwrap(proto.editedMessage ?? {});
    const body = messageText(edited);
    if (body) return { instance, wa_message_id: proto.key.id, edited_body: body };
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
    const message = unwrap(item.message ?? {});
    const type = contentKey(message) ?? item.messageType ?? null;
    if (!type || IGNORED_TYPES.has(type) || type === 'protocolMessage') continue;
    const media = mediaInfo(message, type);
    const timestamp = Number(item.messageTimestamp?.low ?? item.messageTimestamp);
    // Messages read back from Evolution's store carry their receipts apart.
    const status = item.status ?? item.MessageUpdate?.at?.(-1)?.status;
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
      status: key.fromMe ? STATUS[status] ?? 'enviado' : null,
      media,
      raw: item,
    });
  }
  return out;
}

// Edits and deletions, from protocol messages or Evolution's own events.
export function parseChangeEvent(payload) {
  const event = normalizeEvent(payload?.event);
  const instance = String(payload?.instance ?? payload?.instanceName ?? 'default');
  const out = [];
  if (MESSAGE_EVENTS.has(event)) {
    for (const item of asList(payload.data)) {
      const change = protocolChange(instance, item);
      if (change) out.push(change);
    }
  }
  // Evolution v2 also reports a deletion as a status change.
  if (UPDATE_EVENTS.has(event)) {
    for (const item of asList(payload.data)) {
      const id = item?.keyId ?? item?.key?.id;
      if (id && (item?.status ?? item?.update?.status) === 'DELETED') out.push({ instance, wa_message_id: id, deleted: true });
    }
  }
  if (DELETE_EVENTS.has(event)) {
    for (const item of asList(payload.data)) {
      const id = item?.id ?? item?.key?.id ?? item?.keyId;
      if (id) out.push({ instance, wa_message_id: id, deleted: true });
    }
  }
  return out;
}

// connection.update → { instance, state, reason }
export function parseConnectionEvent(payload) {
  if (!CONNECTION_EVENTS.has(normalizeEvent(payload?.event))) return null;
  const data = payload.data ?? {};
  const state = data.state ?? data.connection;
  if (!state) return null;
  return {
    instance: String(payload.instance ?? payload.instanceName ?? data.instance ?? 'default'),
    state: String(state),
    reason: data.statusReason != null ? String(data.statusReason) : null,
  };
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
  const connection = parseConnectionEvent(payload);
  if (connection) {
    await query(`insert into whatsapp_connection_events (instance, state, reason) values ($1, $2, $3)`,
      [connection.instance, connection.state, connection.reason]);
  }

  for (const c of parseChangeEvent(payload)) {
    if (c.deleted) {
      await query(`update whatsapp_messages set deleted_at = coalesce(deleted_at, now()) where instance = $1 and wa_message_id = $2`,
        [c.instance, c.wa_message_id]);
    } else {
      await query(`update whatsapp_messages set body = $3, edited_at = now() where instance = $1 and wa_message_id = $2 and body is distinct from $3`,
        [c.instance, c.wa_message_id, c.edited_body]);
    }
  }

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
