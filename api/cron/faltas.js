import { dispatchNoShows, isDatabaseCronToken } from '../../server/dispatch.js';

// No-show webhook. Called every 10 minutes by the database job (pg_cron +
// pg_net, header x-cron-token) only when some booking is due; the daily
// /api/cron/disparos also drains it. Accepts Vercel's
// "Authorization: Bearer <CRON_SECRET>" too.
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    const secret = process.env.CRON_SECRET;
    const byVercel = Boolean(secret) && req.headers.authorization === `Bearer ${secret}`;
    if (!byVercel && !(await isDatabaseCronToken(req.headers['x-cron-token']))) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ ok: false, erro: 'não autorizado' }));
    }
    const faltas = await dispatchNoShows({ deadline: Date.now() + 50_000 });
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, faltas }));
  } catch (error) {
    console.error(error);
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, erro: error.message }));
  }
}
