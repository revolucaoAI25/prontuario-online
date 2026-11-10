import { dispatchCampaigns, isDatabaseCronToken } from '../../server/dispatch.js';

// Campaigns ("Disparos"). Called by the database job (pg_cron + pg_net,
// header x-cron-token) every 10 seconds, only when a message is due. Accepts
// Vercel's "Authorization: Bearer <CRON_SECRET>" too.
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    const secret = process.env.CRON_SECRET;
    const byVercel = Boolean(secret) && req.headers.authorization === `Bearer ${secret}`;
    if (!byVercel && !(await isDatabaseCronToken(req.headers['x-cron-token']))) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ ok: false, erro: 'não autorizado' }));
    }
    const campanhas = await dispatchCampaigns({ deadline: Date.now() + 45_000 });
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, campanhas }));
  } catch (error) {
    console.error(error);
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, erro: error.message }));
  }
}
