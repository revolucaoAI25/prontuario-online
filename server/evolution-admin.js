import { ApiError } from './http.js';

// Manages the clinic's instance on an Evolution API (v2) server: create it if
// missing, point its webhook at this app, show the QR code, report status.
// The server URL and global key live only in server env vars.
const WEBHOOK_EVENTS = ['MESSAGES_UPSERT', 'SEND_MESSAGE'];

function config() {
  return {
    url: process.env.EVOLUTION_API_URL?.replace(/\/+$/, ''),
    key: process.env.EVOLUTION_API_KEY,
    instance: process.env.EVOLUTION_INSTANCE || 'clinica-rezeck',
  };
}

async function evo(path, { method = 'GET', body } = {}) {
  const { url, key } = config();
  let res;
  try {
    res = await fetch(`${url}${path}`, {
      method,
      headers: { apikey: key, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new ApiError(502, 'evolution_indisponivel', `Não foi possível falar com o servidor da Evolution API (${error.message}).`);
  }
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function fail(status, json) {
  const detail = json?.response?.message ?? json?.message ?? json?.error;
  if (status === 401 || status === 403) {
    throw new ApiError(502, 'evolution_chave_invalida', 'A Evolution API recusou a chave (EVOLUTION_API_KEY).');
  }
  throw new ApiError(502, 'evolution_erro', `Evolution API respondeu ${status}${detail ? `: ${[].concat(detail).join(' ')}` : ''}.`);
}

function publicUrl(req) {
  if (process.env.PUBLIC_APP_URL) return process.env.PUBLIC_APP_URL.replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] ?? 'https';
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  return `${proto}://${host}`;
}

function webhookUrl(req) {
  const secret = process.env.EVOLUTION_WEBHOOK_SECRET;
  if (!secret) throw new ApiError(500, 'configuracao_incompleta', 'Defina EVOLUTION_WEBHOOK_SECRET nas variáveis da Vercel.');
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
export async function whatsappConnect(_body, req) {
  const { url, key, instance } = config();
  if (!url || !key) {
    throw new ApiError(400, 'configuracao_incompleta', 'Defina EVOLUTION_API_URL e EVOLUTION_API_KEY nas variáveis da Vercel.');
  }
  const hook = webhookUrl(req);
  const webhook = { enabled: true, url: hook, byEvents: false, base64: false, events: WEBHOOK_EVENTS };

  let state = await connectionState();
  let qr = null;
  if (state === null) {
    const created = await evo('/instance/create', {
      method: 'POST',
      body: { instanceName: instance, integration: 'WHATSAPP-BAILEYS', qrcode: true, webhook },
    });
    if (created.status >= 400) fail(created.status, created.json);
    qr = created.json.qrcode ?? null;
    state = 'connecting';
  } else {
    const set = await evo(`/webhook/set/${encodeURIComponent(instance)}`, { method: 'POST', body: { webhook } });
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
