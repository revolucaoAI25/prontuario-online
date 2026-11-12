-- Performance fixes found in production (pg_stat_statements, EXPLAIN ANALYZE).

-- 1. Free slots took ~68 s per day: to know whether a slot was taken, every
--    candidate read the agenda's whole history (index on agenda_id,
--    starts_at with only an upper bound). No booking lasts more than a day,
--    so a lower bound one day before keeps it to the bookings around the
--    slot.
create or replace function slot_is_taken(
    p_agenda_id uuid,
    p_starts_at timestamptz,
    p_ends_at timestamptz,
    p_ignore_appointment_id uuid default null
) returns boolean
language sql stable as $$
    select exists (
        select 1 from appointments a
        where a.agenda_id = p_agenda_id
          and a.starts_at >= p_starts_at - interval '1 day'
          and a.starts_at < p_ends_at
          and a.ends_at > p_starts_at
          and appointment_holds_slot(a.status)
          and a.id is distinct from p_ignore_appointment_id
    ) or exists (
        select 1 from agenda_blocks b
        where (b.agenda_id = p_agenda_id or b.agenda_id is null)
          and b.starts_at < p_ends_at
          and b.ends_at > p_starts_at
    )
$$;

-- 2. WhatsApp conversations took ~2.3 s (and the menu's unread count ran it
--    every 15 s on every open screen): the counts and the patient lookup ran
--    once per message instead of once per conversation. Same columns.
create or replace view whatsapp_conversations with (security_invoker = true) as
with last as (
    select distinct on (m.remote_jid)
        m.remote_jid, m.phone_digits, m.patient_id, m.push_name, m.body, m.media_kind, m.from_me, m.status, m.sent_at
    from whatsapp_messages m
    order by m.remote_jid, m.sent_at desc
),
stats as (
    select m.remote_jid,
           count(*) as message_count,
           count(*) filter (where not m.from_me and m.sent_at > coalesce(r.read_at, '-infinity'::timestamptz)) as unread_count,
           (array_agg(m.push_name order by m.sent_at desc) filter (where m.push_name is not null))[1] as known_name
    from whatsapp_messages m
    left join whatsapp_reads r on r.remote_jid = m.remote_jid
    group by m.remote_jid
),
conv as (
    select l.remote_jid, l.phone_digits,
           coalesce(l.patient_id, match_patient_by_phone(l.phone_digits)) as patient_id,
           coalesce(l.push_name, s.known_name) as push_name,
           l.body as last_body, l.media_kind as last_media_kind, l.from_me as last_from_me,
           l.status as last_status, l.sent_at as last_at,
           s.message_count, s.unread_count
    from last l
    join stats s on s.remote_jid = l.remote_jid
)
select c.remote_jid, c.phone_digits, c.patient_id, c.push_name, c.last_body, c.last_media_kind, c.last_from_me,
       c.last_status, c.last_at, c.message_count, c.unread_count, p.full_name as patient_name
from conv c
left join patients p on p.id = c.patient_id;

-- The menu only needs the total of unread patient messages.
create function whatsapp_unread_total() returns integer
language sql stable as $$
    select count(*)::integer
    from whatsapp_messages m
    left join whatsapp_reads r on r.remote_jid = m.remote_jid
    where not m.from_me and m.sent_at > coalesce(r.read_at, '-infinity'::timestamptz)
$$;

-- 3. "Últimos registros" (Prontuários) sorted all 154 thousand entries.
create index if not exists record_entries_entry_at_idx on record_entries (entry_at desc);

-- 4. Payments: the visibility check ran per row (with a staff lookup each
--    time). The shared agendas are now read once per query.
create function finance_shared_agendas() returns uuid[]
language sql stable security definer set search_path = public as $$
    select coalesce(array_agg(id), '{}') from agendas where finance_shared and is_staff()
$$;

drop policy payments_select on payments;
drop policy payments_update on payments;
create policy payments_select on payments for select to authenticated using (
    (select is_admin())
    or ((select is_staff()) and (agenda_id is null or agenda_id = any ((select finance_shared_agendas())::uuid[])))
);
create policy payments_update on payments for update to authenticated using (
    (select is_admin())
    or ((select is_staff()) and (agenda_id is null or agenda_id = any ((select finance_shared_agendas())::uuid[])))
) with check ((select is_staff()));

create index if not exists payments_pending_idx on payments (occurred_on) where status = 'pendente';

-- 5. The scheduler logs every run (one every 10 seconds); keep a week of it.
do $$
begin
    if exists (select 1 from pg_extension where extname = 'pg_cron') then
        perform cron.schedule('limpar-historico-jobs', '17 4 * * *',
            $job$delete from cron.job_run_details where end_time < now() - interval '7 days'$job$);
    end if;
end;
$$;

analyze appointments;
analyze record_entries;
analyze payments;
analyze whatsapp_messages;
