import { query } from './db.js';
import { ApiError } from './http.js';
import { formatContactPatient } from './patient-context.js';
import { parseUuid } from './scheduling.js';

const TZ = 'America/Sao_Paulo';

function intIn(value, field, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ApiError(400, 'campo_invalido', `"${field}" deve ser um número inteiro entre ${min} e ${max}.`, { campo: field });
  }
  return n;
}

// POST /api/pacientes/reativacao — patients who used to come and stopped:
// at least one visit, none in the last N months, nothing booked, a WhatsApp
// number, accepting messages, and not contacted for this recently. Most
// recently lapsed first. Mark each one sent with /pacientes/marcar_reativacao
// so the next call brings the following batch.
export async function reactivationList(body) {
  const months = intIn(body.meses_sem_vir, 'meses_sem_vir', 12, 1, 240);
  const limit = intIn(body.limite, 'limite', 50, 1, 500);
  const skipDays = intIn(body.dias_desde_ultimo_contato, 'dias_desde_ultimo_contato', 90, 0, 3650);
  const { rows } = await query(
    `with last_visit as (
       select a.patient_id, max(a.starts_at) as last_at, count(*)::int as visits
       from appointments a where a.status = 'chegou' group by a.patient_id
     )
     select p.*, p.birth_date::text as birth_day, extract(year from age(clinic_today(), p.birth_date))::int as age,
            lv.visits, to_char(lv.last_at at time zone '${TZ}', 'YYYY-MM-DD') as last_day,
            (select ag.name from appointments a join agendas ag on ag.id = a.agenda_id
             where a.patient_id = p.id and a.status = 'chegou' order by a.starts_at desc limit 1) as last_agenda,
            (select coalesce(array_agg(distinct pr.name), '{}') from appointments a
             join appointment_procedures ap on ap.appointment_id = a.id join procedures pr on pr.id = ap.procedure_id
             where a.patient_id = p.id and a.status = 'chegou') as procedures,
            (extract(year from age(clinic_today(), (lv.last_at at time zone '${TZ}')::date)) * 12
             + extract(month from age(clinic_today(), (lv.last_at at time zone '${TZ}')::date)))::int as months_away,
            to_char(p.reactivation_contacted_at at time zone '${TZ}', 'YYYY-MM-DD') as contacted_day
     from patients p
     join last_visit lv on lv.patient_id = p.id
     where p.allow_messages
       and length(p.phone_digits) >= 10
       and lv.last_at < now() - make_interval(months => $1)
       and not exists (select 1 from appointments f where f.patient_id = p.id and f.starts_at > now()
                       and f.status in ('agendado', 'confirmado'))
       and (p.reactivation_contacted_at is null or p.reactivation_contacted_at < now() - make_interval(days => $3))
     order by lv.last_at desc
     limit $2`,
    [months, limit, skipDays],
  );
  return {
    criterios: { meses_sem_vir: months, dias_desde_ultimo_contato: skipDays },
    total: rows.length,
    pacientes: rows.map((r) => ({
      paciente: formatContactPatient(r),
      ultimo_atendimento: r.last_day,
      ultima_agenda: r.last_agenda,
      meses_sem_vir: r.months_away,
      total_atendimentos: r.visits,
      procedimentos_ja_feitos: r.procedures,
      ultimo_contato_reativacao: r.contacted_day,
    })),
  };
}

// POST /api/pacientes/marcar_reativacao — the campaign wrote to these patients.
export async function markReactivation(body) {
  const ids = (Array.isArray(body.pacientes) ? body.pacientes : [body.paciente_id]).filter(Boolean);
  if (ids.length === 0) {
    throw new ApiError(400, 'campo_obrigatorio', 'Informe "paciente_id" ou a lista "pacientes".', { campo: 'paciente_id' });
  }
  if (ids.length > 500) throw new ApiError(400, 'campo_invalido', 'No máximo 500 pacientes por chamada.', { campo: 'pacientes' });
  const valid = ids.map((id) => parseUuid(id, 'pacientes'));
  const { rowCount } = await query(`update patients set reactivation_contacted_at = now() where id = any($1::uuid[])`, [valid]);
  return { marcados: rowCount };
}
