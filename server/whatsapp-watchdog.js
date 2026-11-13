import { query, queryOne } from './db.js';
import { connectionState, evolutionConfig, restartInstance, syncFromEvolution } from './evolution-admin.js';

// Runs every 2 minutes (database job → /api/cron/whatsapp). Keeps the
// WhatsApp mirror complete and on time, and tells the team when only a new
// QR Code reading will fix it.
//
//   * Missing messages: whatever Evolution has from the last hours and the
//     webhook didn't deliver is added.
//   * Stuck connection: Evolution can report "open" while nothing arrives.
//     Signs: messages arriving late (it was offline and is catching up), or
//     silence during opening hours. The connection is then restarted (at
//     most every RESTART_EVERY_MIN), which also pulls the late messages.
//   * When restarts don't fix it (MAX_RESTARTS within an hour), the status
//     becomes "precisa_reconectar" and every screen asks for a new QR Code.

const SYNC_HOURS = 3;
const LATE_MIN = 5; // a message that took longer than this to arrive
const SILENCE_MIN = 20; // no message at all for this long, while open
const RESTART_EVERY_MIN = 6; // while messages arrive late (draining)
const SILENT_RESTART_EVERY_MIN = 15; // silence alone (could be a quiet hour)
const MAX_RESTARTS = 5; // late after this many restarts in an hour → new QR

// Opening hours (Brazil time): silence outside them is normal.
function isOpeningHours(now = new Date()) {
  const local = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const day = local.getDay();
  const minutes = local.getHours() * 60 + local.getMinutes();
  if (day === 0) return false;
  return minutes >= 8 * 60 + 30 && minutes < (day === 6 ? 14 : 19) * 60;
}

async function saveStatus(fields) {
  const keys = Object.keys(fields);
  await query(
    `update whatsapp_watchdog set checked_at = now(), ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} where id = 1`,
    keys.map((k) => fields[k]),
  );
}

export async function whatsappWatchdog({ now = new Date() } = {}) {
  const { url, key } = evolutionConfig();
  if (!url || !key) {
    await saveStatus({ status: 'nao_configurado', detail: null });
    return { status: 'nao_configurado' };
  }
  const watch = await queryOne(`select * from whatsapp_watchdog where id = 1`);
  const recent = (watch?.restarts ?? []).filter((t) => now - new Date(t) < 3600_000);
  const lastRestart = recent.length ? Math.max(...recent.map((t) => new Date(t).getTime())) : 0;

  let state;
  try {
    state = await connectionState();
  } catch (error) {
    await saveStatus({ status: 'desconectado', state: 'erro', detail: `Servidor do WhatsApp fora do ar: ${error.message}` });
    return { status: 'desconectado' };
  }

  // 1. Anything the webhook missed.
  let added = 0;
  if (state === 'open') {
    try {
      ({ novas: added } = await syncFromEvolution({ from: new Date(now - SYNC_HOURS * 3600_000), to: now, historic: false, mediaNow: 5 }));
    } catch (error) {
      console.error('whatsapp sync', error);
    }
  }

  // 2. Is it receiving on time?
  const signs = await queryOne(
    `select max(created_at) as last_arrival,
            count(*) filter (where created_at > now() - interval '10 minutes'
                               and created_at - sent_at > make_interval(mins => $1))::int as late
     from whatsapp_messages where sent_by is null`,
    [LATE_MIN],
  );
  const lastArrival = signs?.last_arrival ? new Date(signs.last_arrival) : null;
  const silentFor = lastArrival ? (now - lastArrival) / 60_000 : Infinity;
  const late = signs?.late > 0 || added > 0;
  const silent = isOpeningHours(now) && silentFor > SILENCE_MIN;
  const unhealthy = state !== 'open' || late || silent;
  const wait = (late || state !== 'open' ? RESTART_EVERY_MIN : SILENT_RESTART_EVERY_MIN) * 60_000;

  let restarted = false;
  if (unhealthy && state !== 'close' && now - lastRestart > wait && recent.length < MAX_RESTARTS) {
    try {
      await restartInstance();
      restarted = true;
      recent.push(now.toISOString());
      await query(`insert into whatsapp_connection_events (instance, state, reason) values ($1, 'reiniciado', $2)`,
        [evolutionConfig().instance, late ? 'mensagens chegando atrasadas' : silent ? `${Math.round(silentFor)} min sem mensagens` : `estado ${state}`]);
    } catch (error) {
      console.error('whatsapp restart', error);
    }
  }

  let status = 'ok';
  let detail = null;
  if (state === 'close' || state === null) {
    status = 'desconectado';
    detail = 'O número foi desconectado. Leia o QR Code com o celular da clínica.';
  } else if ((late || state !== 'open') && recent.length >= MAX_RESTARTS) {
    status = 'precisa_reconectar';
    detail = 'O WhatsApp parou de sincronizar e não voltou sozinho. Gere um novo QR Code e leia com o celular da clínica.';
  } else if (late) {
    status = 'atrasado';
    detail = 'Recebendo mensagens que estavam atrasadas.';
  } else if (state !== 'open') {
    status = 'travado';
    detail = 'Conexão instável; reiniciando.';
  } else if (silent) {
    detail = `Sem mensagens há ${Math.round(silentFor)} min${restarted ? '; conexão reiniciada por precaução' : ''}.`;
  }

  await saveStatus({
    state: state ?? 'inexistente',
    status,
    detail,
    last_arrival_at: lastArrival,
    restarts: recent,
    ...(state === 'open' ? { last_sync_added: added, last_sync_at: now } : {}),
  });
  return { status, estado: state, adicionadas: added, reiniciado: restarted, sem_mensagens_min: Number.isFinite(silentFor) ? Math.round(silentFor) : null };
}
