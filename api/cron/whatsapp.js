import { isDatabaseCronToken } from '../../server/dispatch.js';
import { whatsappWatchdog } from '../../server/whatsapp-watchdog.js';

// WhatsApp watchdog, called every 2 minutes by the database job (pg_cron +
// pg_net, header x-cron-token). Accepts Vercel's "Authorization: Bearer
// <CRON_SECRET>" too.
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    const secret = process.env.CRON_SECRET;
    const byVercel = Boolean(secret) && req.headers.authorization === `Bearer ${secret}`;
    if (!byVercel && !(await isDatabaseCronToken(req.headers['x-cron-token']))) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ ok: false, erro: 'não autorizado' }));
    }
    const whatsapp = await whatsappWatchdog();
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, whatsapp }));
  } catch (error) {
    console.error(error);
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, erro: error.message }));
  }
}
