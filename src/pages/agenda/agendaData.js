import { supabase, must } from '../../lib/supabase.js';
import { addDays, localDay, localMinutes, timeToMinutes, weekday, zonedToUtc } from '../../lib/time.js';

export const APPOINTMENT_SELECT = `*,
  patient:patients(id, full_name, phone, birth_date, address),
  type:appointment_types(id, name, display_name, duration_minutes),
  appointment_procedures(procedure:procedures(id, name, reminder_months))`;

// What the clinic sees for a type: "Retorno" for the API's "Avaliação estética".
export const typeLabel = (type) => type?.display_name || type?.name || '';

export const proceduresOf = (appointment) => (appointment.appointment_procedures ?? []).map((ap) => ap.procedure).filter(Boolean);

export async function loadAgendas() {
  return must(
    supabase
      .from('agendas')
      .select('*, appointment_types(*), agenda_hours(*), agenda_slot_times(*)')
      .eq('active', true)
      .order('sort_order'),
  );
}

// Bookings, blocks and one-day openings from `fromDay` up to (not including)
// `toDay`, clinic time.
export async function loadRange(fromDay, toDay) {
  const from = zonedToUtc(fromDay, '00:00').toISOString();
  const to = zonedToUtc(toDay, '00:00').toISOString();
  const [appointments, blocks, openings] = await Promise.all([
    must(supabase.from('appointments').select(APPOINTMENT_SELECT).gte('starts_at', from).lt('starts_at', to).order('starts_at')),
    must(supabase.from('agenda_blocks').select('*').lt('starts_at', to).gt('ends_at', from)),
    must(supabase.from('agenda_openings').select('*').lt('starts_at', to).gt('ends_at', from)),
  ]);
  return { appointments, blocks, openings };
}

export const loadDay = (day) => loadRange(day, addDays(day, 1));

export const defaultType = (agenda) =>
  agenda?.appointment_types?.find((t) => t.is_default && t.active) ?? agenda?.appointment_types?.[0] ?? null;

export const activeTypes = (agenda) =>
  (agenda?.appointment_types ?? []).filter((t) => t.active).sort((a, b) => a.sort_order - b.sort_order);

export function fixedTimes(agenda, day) {
  const dow = weekday(day);
  return (agenda?.agenda_slot_times ?? [])
    .filter((s) => s.weekday === dow)
    .map((s) => timeToMinutes(s.start_time))
    .sort((a, b) => a - b);
}

// The agenda's weekly hours on that day, plus its one-day openings
// (agenda.openings, attached by the agenda page).
export function openWindows(agenda, day) {
  const dow = weekday(day);
  const weekly = (agenda?.agenda_hours ?? [])
    .filter((h) => h.weekday === dow)
    .map((h) => [timeToMinutes(h.start_time), timeToMinutes(h.end_time)]);
  const extra = (agenda?.openings ?? [])
    .filter((o) => localDay(o.starts_at) <= day && localDay(o.ends_at) >= day)
    .map((o) => [localDay(o.starts_at) === day ? localMinutes(o.starts_at) : 0, localDay(o.ends_at) === day ? localMinutes(o.ends_at) : 24 * 60])
    .filter(([s, e]) => e > s);
  return [...weekly, ...extra].sort((a, b) => a[0] - b[0]);
}

// Same rule as default_end() in SQL: on a fixed start time the slot lasts
// until the next fixed start, capped by the type's duration.
export function defaultEndMinutes(agenda, day, startMin, duration) {
  const fixed = fixedTimes(agenda, day);
  const end = startMin + duration;
  if (!fixed.includes(startMin)) return end;
  const next = fixed.find((t) => t > startMin);
  return next ? Math.min(end, next) : end;
}

export async function setAppointmentProcedures(appointmentId, procedures) {
  const ids = procedures.map((p) => p.id);
  let remove = supabase.from('appointment_procedures').delete().eq('appointment_id', appointmentId);
  if (ids.length) remove = remove.not('procedure_id', 'in', `(${ids.join(',')})`);
  await must(remove);
  if (ids.length) {
    await must(
      supabase
        .from('appointment_procedures')
        .upsert(ids.map((id) => ({ appointment_id: appointmentId, procedure_id: id })), {
          onConflict: 'appointment_id,procedure_id',
          ignoreDuplicates: true,
        }),
    );
  }
}

// Bookings already holding this time in the agenda (manual overlap is allowed,
// but the user is warned first).
export async function findOverlaps(agendaId, startsAt, endsAt, ignoreId) {
  let query = supabase
    .from('appointments')
    .select('id, starts_at, patient:patients(full_name)')
    .eq('agenda_id', agendaId)
    .in('status', ['agendado', 'confirmado', 'chegou'])
    .lt('starts_at', endsAt)
    .gt('ends_at', startsAt);
  if (ignoreId) query = query.neq('id', ignoreId);
  return must(query);
}
