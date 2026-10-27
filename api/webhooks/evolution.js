import { timingSafeEqual } from 'node:crypto';
import { storeEvolutionEvent } from '../../server/evolution.js';
import { downloadPendingMedia } from '../../server/evolution-admin.js';

function secretMatches(given, expected) {
  if (!given || !expected) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req) {
  if (req.body !== undefined) return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

// Configure in the Evolution instance: webhook URL
//   https://<domain>/api/webhooks/evolution?secret=<EVOLUTION_WEBHOOK_SECRET>
// with the MESSAGES_UPSERT, SEND_MESSAGE and MESSAGES_UPDATE events (the
// "Conectar" button in Ajustes does this).
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const url = new URL(req.url, 'http://localhost');
  const given = url.searchParams.get('secret') ?? req.headers['x-webhook-secret'];
  if (!secretMatches(given, process.env.EVOLUTION_WEBHOOK_SECRET)) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ ok: false }));
  }
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ ok: false }));
  }
  try {
    const { midias_pendentes: media, ...result } = await storeEvolutionEvent(await readJson(req));
    // Copy attachments into Storage before answering (the function may be
    // frozen right after the response). A failure stays visible in the
    // conversation with a "try again" button.
    await downloadPendingMedia(media);
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, ...result, midias: media.length }));
  } catch (error) {
    console.error(error);
    res.statusCode = error instanceof SyntaxError ? 400 : 500;
    res.end(JSON.stringify({ ok: false }));
  }
}
