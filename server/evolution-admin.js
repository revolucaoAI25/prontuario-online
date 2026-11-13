import { ApiError } from './http.js';
import { query, queryOne } from './db.js';
import { adminClient } from './supabase-admin.js';
import { storeEvolutionEvent } from './evolution.js';
import { whatsappNumber } from './patient-context.js';

// Manages the clinic's instance on an Evolution API (v2) server: create it if
// missing, point its webhook at this app, show the QR code, report status,
// and send text messages from the conversations screen.
// The server URL and global key live only in server env vars.
const WEBHOOK_EVENTS = ['MESSAGES_UPSERT', 'SEND_MESSAGE', 'MESSAGES_UPDATE'];
// Edits, deletions and connection drops: newer Evolution servers only (an
// older one refuses the list, and the basic events are applied instead).
const EXTRA_EVENTS = ['MESSAGES_EDITED', 'MESSAGES_DELETE', 'CONNECTION_UPDATE'];

function config() {
  return {
    url: process.env.EVOLUTION_API_URL?.replace(/\/+$/, ''),
    key: process.env.EVOLUTION_API_KEY,
    instance: process.env.EVOLUTION_INSTANCE || 'clinica-rezeck',
  };
}

async function evo(path, { method = 'GET', body, timeout = 15_000 } = {}) {
  const { url, key } = config();
  let res;
  try {
    res = await fetch(`${url}${path}`, {
      method,
      headers: { apikey: key, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    throw new ApiError(502, 'evolution_indisponivel', 'Não foi possível falar com o servidor do WhatsApp. Tente de novo em instantes.');
  }
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function fail(status, json) {
  const detail = json?.response?.message ?? json?.message ?? json?.error;
  if (status === 401 || status === 403) {
    throw new ApiError(502, 'evolution_chave_invalida', 'O servidor do WhatsApp recusou a conexão. Fale com o suporte técnico.');
  }
  throw new ApiError(502, 'evolution_erro', `O servidor do WhatsApp respondeu com erro (${status}${detail ? `: ${[].concat(detail).join(' ')}` : ''}).`);
}

function publicUrl(req) {
  if (process.env.PUBLIC_APP_URL) return process.env.PUBLIC_APP_URL.replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] ?? 'https';
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  return `${proto}://${host}`;
}

function webhookUrl(req) {
  const secret = process.env.EVOLUTION_WEBHOOK_SECRET;
  if (!secret) throw new ApiError(500, 'configuracao_incompleta', 'O WhatsApp ainda não foi configurado. Fale com o suporte técnico.');
  return `${publicUrl(req)}/api/webhooks/evolution?secret=${encodeURIComponent(secret)}`;
}

async function connectionState() {
  const { instance } = config();
  const { status, json } = await evo(`/instance/connectionState/${encodeURIComponent(instance)}`);
  if (status === 404) return null;
  if (status >= 400) fail(status, json);
  return json.instance?.state ?? json.state ?? 'close';
}

export async function whatsappStatus() {
  const { url, key, instance } = config();
  if (!url || !key) return { configurado: false };
  const state = await connectionState();
  return { configurado: true, instancia: instance, existe: state !== null, estado: state ?? 'inexistente' };
}

// Creates the instance if needed, (re)applies the webhook, and returns the
// QR code when the number still has to be scanned.
export async function whatsappConnect(body, req) {
  const { url, key, instance } = config();
  if (!url || !key) {
    throw new ApiError(400, 'configuracao_incompleta', 'O WhatsApp ainda não foi configurado. Fale com o suporte técnico.');
  }
  const hook = webhookUrl(req);
  const webhook = { enabled: true, url: hook, byEvents: false, base64: false, events: [...WEBHOOK_EVENTS, ...EXTRA_EVENTS] };

  // "Gerar novo QR Code": a connection that says it's open but stopped
  // receiving only recovers with a fresh pairing.
  if (body?.novo_qr) {
    const out = await evo(`/instance/logout/${encodeURIComponent(instance)}`, { method: 'DELETE' });
    if (out.status >= 400 && out.status !== 404) fail(out.status, out.json);
    await query(`insert into whatsapp_connection_events (instance, state, reason) values ($1, 'close', 'novo QR Code pedido no sistema')`, [instance]);
  }

  let state = await connectionState();
  let qr = null;
  if (state === null) {
    let created = await evo('/instance/create', {
      method: 'POST',
      body: { instanceName: instance, integration: 'WHATSAPP-BAILEYS', qrcode: true, webhook },
    });
    if (created.status === 400) {
      created = await evo('/instance/create', {
        method: 'POST',
        body: { instanceName: instance, integration: 'WHATSAPP-BAILEYS', qrcode: true, webhook: { ...webhook, events: WEBHOOK_EVENTS } },
      });
    }
    if (created.status >= 400) fail(created.status, created.json);
    qr = created.json.qrcode ?? null;
    state = 'connecting';
  } else {
    let set = await evo(`/webhook/set/${encodeURIComponent(instance)}`, { method: 'POST', body: { webhook } });
    if (set.status === 400) {
      set = await evo(`/webhook/set/${encodeURIComponent(instance)}`, { method: 'POST', body: { webhook: { ...webhook, events: WEBHOOK_EVENTS } } });
    }
    if (set.status >= 400) fail(set.status, set.json);
  }

  if (state === 'open') return { instancia: instance, estado: 'open', webhook: hook.replace(/secret=[^&]+/, 'secret=***') };

  if (!qr?.base64) {
    const conn = await evo(`/instance/connect/${encodeURIComponent(instance)}`);
    if (conn.status >= 400) fail(conn.status, conn.json);
    qr = conn.json;
  }
  return {
    instancia: instance,
    estado: state,
    qrcode: qr?.base64 ?? null,
    codigo_pareamento: qr?.pairingCode ?? null,
  };
}

export async function whatsappDisconnect() {
  const { instance } = config();
  const { status, json } = await evo(`/instance/logout/${encodeURIComponent(instance)}`, { method: 'DELETE' });
  if (status >= 400 && status !== 404) fail(status, json);
  return { estado: 'close' };
}

const MAX_TEXT = 4096;
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const BUCKET = 'prontuario';
const EXT_BY_MIME = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/3gpp': '3gp', 'video/quicktime': 'mov',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/webm': 'webm',
  'application/pdf': 'pdf',
};
// What Evolution's sendMedia calls each kind, and ours.
const SEND_KIND = { image: 'imagem', video: 'video', audio: 'audio', document: 'documento' };

function sendKindFor(mime) {
  if (/^image\/(jpeg|png|webp)$/.test(mime)) return 'image';
  if (/^video\//.test(mime)) return 'video';
  if (/^audio\//.test(mime)) return 'audio';
  return 'document';
}

async function resolveNumber(body) {
  let number = whatsappNumber(body.telefone);
  if (!number && body.paciente_id) {
    const patient = await queryOne(`select phone_digits from patients where id = $1`, [String(body.paciente_id)]);
    number = whatsappNumber(patient?.phone_digits);
  }
  if (!number && /^[\w.-]+@(s\.whatsapp\.net|lid)$/.test(String(body.remote_jid ?? ''))) number = body.remote_jid;
  if (!number) throw new ApiError(400, 'campo_invalido', 'Telefone inválido para WhatsApp.', { campo: 'telefone' });
  return number;
}

// A file the browser already uploaded to Storage under whatsapp/.
function parseUpload(midia) {
  const path = String(midia?.path ?? '');
  if (!/^whatsapp\/[\w\-./ ()]+$/.test(path) || path.includes('..')) {
    throw new ApiError(400, 'campo_invalido', 'Arquivo inválido.', { campo: 'midia' });
  }
  const mime = String(midia.mime || 'application/octet-stream').split(';')[0].toLowerCase();
  return { path, mime, name: midia.nome ? String(midia.nome).slice(0, 200) : path.split('/').pop(), size: Number(midia.tamanho) || null };
}

// POST /api/whatsapp/enviar — any logged-in staff member. The destination is
// the conversation's phone (or chat id), or a patient's phone. Sends text, or
// a file (with `texto` as its caption); `voz: true` sends audio as a voice note.
export async function whatsappSend(body, _req, staff) {
  const { url, key, instance } = config();
  if (!url || !key) throw new ApiError(400, 'configuracao_incompleta', 'O WhatsApp da clínica ainda não foi configurado.');
  const text = String(body.texto ?? '').trim();
  const file = body.midia ? parseUpload(body.midia) : null;
  if (!text && !file) throw new ApiError(400, 'campo_obrigatorio', 'Escreva a mensagem.', { campo: 'texto' });
  if (text.length > MAX_TEXT) throw new ApiError(400, 'campo_invalido', `A mensagem passa de ${MAX_TEXT} caracteres.`, { campo: 'texto' });
  const number = await resolveNumber(body);

  const state = await connectionState();
  if (state !== 'open') throw new ApiError(409, 'whatsapp_desconectado', 'O WhatsApp da clínica está desconectado. Peça ao administrador para conectar em Ajustes.');

  let request;
  let media = null;
  if (file) {
    const { data, error } = await adminClient().storage.from(BUCKET).createSignedUrl(file.path, 15 * 60);
    if (error || !data?.signedUrl) throw new ApiError(400, 'arquivo_nao_encontrado', 'O arquivo enviado não foi encontrado. Tente anexar de novo.');
    const kind = sendKindFor(file.mime);
    media = { ...file, kind: SEND_KIND[kind] };
    request = body.voz && kind === 'audio'
      ? { path: 'sendWhatsAppAudio', body: { number, audio: data.signedUrl } }
      : { path: 'sendMedia', body: { number, mediatype: kind, mimetype: file.mime, caption: text || undefined, media: data.signedUrl, fileName: file.name } };
  } else {
    request = { path: 'sendText', body: { number, text } };
  }

  const { status, json } = await evo(`/message/${request.path}/${encodeURIComponent(instance)}`, {
    method: 'POST',
    body: request.body,
    timeout: file ? 60_000 : 15_000,
  });
  if (status >= 400) {
    const detail = JSON.stringify(json?.response?.message ?? json?.message ?? '');
    if (/exists"?\s*:\s*false/.test(detail)) throw new ApiError(400, 'numero_sem_whatsapp', 'Esse número não tem WhatsApp.');
    fail(status, json);
  }
  // Store it right away (with who sent it and our copy of the file);
  // Evolution's webhook for the same message then only fills gaps.
  await storeEvolutionEvent({ event: 'send.message', instance, data: json }, { sentBy: staff.id, media });
  return { enviado: true, mensagem_id: json?.key?.id ?? null };
}

function extensionFor(mime, name) {
  const fromName = String(name ?? '').match(/\.([a-z0-9]{1,5})$/i)?.[1];
  return (EXT_BY_MIME[mime] ?? fromName ?? 'bin').toLowerCase();
}

// Copies one received (or phone-sent) attachment from Evolution into Storage.
export async function downloadMedia(messageId) {
  const { url, key, instance } = config();
  if (!url || !key) return { ok: false, motivo: 'whatsapp_nao_configurado' };
  const row = await queryOne(`select * from whatsapp_messages where id = $1`, [messageId]);
  if (!row || !row.media_kind) return { ok: false, motivo: 'sem_midia' };
  if (row.media_status === 'ok') return { ok: true };
  try {
    const { status, json } = await evo(`/chat/getBase64FromMediaMessage/${encodeURIComponent(row.instance || instance)}`, {
      method: 'POST',
      // The whole message goes along, so Evolution can decrypt it even when
      // it did not keep a copy (it only looks the id up otherwise).
      body: { message: row.raw?.message ? { key: row.raw.key, message: row.raw.message } : { key: { id: row.wa_message_id } }, convertToMp4: false },
      timeout: 60_000,
    });
    if (status >= 400 || !json?.base64) {
      throw new Error(`Evolution respondeu ${status}${json?.response?.message ? `: ${[].concat(json.response.message).join(' ')}` : ''}`);
    }
    const bytes = Buffer.from(String(json.base64).replace(/^data:[^,]+,/, ''), 'base64');
    if (bytes.length > MAX_MEDIA_BYTES) throw new Error('arquivo maior que 50 MB');
    const mime = String(json.mimetype || row.media_mime || 'application/octet-stream').split(';')[0];
    const name = json.fileName || row.media_name;
    const month = new Date(row.sent_at).toISOString().slice(0, 7);
    const path = `whatsapp/recebidas/${month}/${row.wa_message_id.replace(/[^\w-]/g, '')}.${extensionFor(mime, name)}`;
    const { error } = await adminClient().storage.from(BUCKET).upload(path, bytes, { contentType: mime, upsert: true });
    if (error) throw new Error(`Storage: ${error.message}`);
    await query(
      `update whatsapp_messages set media_status = 'ok', media_path = $2, media_mime = $3, media_size = $4,
              media_name = coalesce(media_name, $5), media_error = null
       where id = $1`,
      [row.id, path, mime, bytes.length, name ?? null],
    );
    return { ok: true };
  } catch (error) {
    await query(`update whatsapp_messages set media_status = 'erro', media_error = $2 where id = $1 and media_status <> 'ok'`, [row.id, error.message]);
    return { ok: false, motivo: error.message };
  }
}

export async function downloadPendingMedia(ids) {
  for (const id of ids) await downloadMedia(id);
}

// POST /api/whatsapp/midia — try again to fetch an attachment that failed.
export async function whatsappRetryMedia(body) {
  const result = await downloadMedia(String(body.id ?? ''));
  if (!result.ok) throw new ApiError(502, 'midia_indisponivel', `Não foi possível baixar o arquivo (${result.motivo}).`);
  return {};
}

// Messages of a period kept in Evolution's own store.
const SYNC_PAGE = 100;
const SYNC_MAX_PAGES = 60;
const SYNC_MEDIA_NOW = 15;

async function fetchStoredMessages(from, to) {
  const { instance } = config();
  const records = [];
  for (let page = 1; page <= SYNC_MAX_PAGES; page++) {
    const { status, json } = await evo(`/chat/findMessages/${encodeURIComponent(instance)}`, {
      method: 'POST',
      body: { where: { messageTimestamp: { gte: from.toISOString(), lte: to.toISOString() } }, page, offset: SYNC_PAGE },
      timeout: 30_000,
    });
    if (status === 404) throw new ApiError(502, 'evolution_erro', 'Este servidor do WhatsApp não permite buscar mensagens antigas.');
    if (status >= 400) fail(status, json);
    const box = json?.messages ?? json;
    const list = Array.isArray(box) ? box : box?.records ?? [];
    // Some servers ignore the date filter: stop once the page is older.
    const inRange = list.filter((r) => Number(r?.messageTimestamp) * 1000 >= from.getTime());
    records.push(...inRange);
    const pages = Number(box?.pages) || 0;
    if (list.length < SYNC_PAGE || inRange.length < list.length || (pages && page >= pages)) break;
  }
  return records;
}

// Stores those the system doesn't have yet. `historic`: their own time
// counts as arrival (old messages don't show up as new).
export async function syncFromEvolution({ from, to = new Date(), historic = true, mediaNow = SYNC_MEDIA_NOW }) {
  const { instance } = config();
  const records = await fetchStoredMessages(from, to);
  const ids = [...new Set(records.map((r) => r?.key?.id).filter(Boolean))];
  const { rows } = ids.length
    ? await query(`select wa_message_id from whatsapp_messages where wa_message_id = any($1)`, [ids])
    : { rows: [] };
  const have = new Set(rows.map((r) => r.wa_message_id));
  const seen = new Set();
  const missing = records.filter((r) => {
    const id = r?.key?.id;
    if (!id || have.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  // Messages that carry the phone first, so "@lid"-only ones of the same
  // contact find their conversation.
  missing.sort((a, b) => Number(Boolean(b?.key?.remoteJidAlt || b?.key?.senderPn)) - Number(Boolean(a?.key?.remoteJidAlt || a?.key?.senderPn)));
  let added = 0;
  const media = [];
  for (let i = 0; i < missing.length; i += SYNC_PAGE) {
    const result = await storeEvolutionEvent({ event: 'messages.set', instance, data: missing.slice(i, i + SYNC_PAGE) }, { historic });
    added += result.gravadas;
    media.push(...result.midias_pendentes);
  }
  // A few attachments now; the rest download when opened ("tentar de novo").
  await downloadPendingMedia(media.slice(0, mediaNow));
  return { encontradas: records.length, novas: added };
}

// POST /api/whatsapp/sincronizar — fetch from Evolution's own store the
// messages of the last days that never reached the system (webhook down,
// server restarted...). Only adds what is missing; nothing is changed.
export async function whatsappSync(body) {
  const { url, key } = config();
  if (!url || !key) throw new ApiError(400, 'configuracao_incompleta', 'O WhatsApp da clínica ainda não foi configurado.');
  const days = Math.min(Math.max(Number(body.dias) || 3, 1), 15);
  const result = await syncFromEvolution({ from: new Date(Date.now() - days * 86_400_000) });
  return { dias: days, ...result };
}

// Reopens the connection to WhatsApp without logging the number out.
export async function restartInstance() {
  const { instance } = config();
  let r = await evo(`/instance/restart/${encodeURIComponent(instance)}`, { method: 'POST', timeout: 30_000 });
  if (r.status === 404 || r.status === 405) r = await evo(`/instance/restart/${encodeURIComponent(instance)}`, { method: 'PUT', timeout: 30_000 });
  if (r.status >= 400) fail(r.status, r.json);
  return true;
}

export { connectionState, config as evolutionConfig };
