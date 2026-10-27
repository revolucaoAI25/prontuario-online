import { dispatchBirthdays, dispatchReminders } from '../../server/dispatch.js';

// Daily job (vercel.json → crons). Vercel calls it with
// "Authorization: Bearer <CRON_SECRET>".
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const expected = process.env.CRON_SECRET;
  if (!expected || req.headers.authorization !== `Bearer ${expected}`) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ ok: false, erro: 'não autorizado' }));
  }
  try {
    const deadline = Date.now() + 50_000;
    const lembretes = await dispatchReminders({ deadline });
    const aniversarios = await dispatchBirthdays({ deadline });
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, lembretes, aniversarios }));
  } catch (error) {
    console.error(error);
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, erro: error.message }));
  }
}
