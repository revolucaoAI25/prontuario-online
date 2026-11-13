-- WhatsApp reliability (review of 13/11).
--
-- 1. Unread is decided by when a message reached the system, not by the
--    time printed on it. When the Evolution server is offline, messages
--    arrive late (up to hours) with their original time; if someone had
--    opened the conversation in between, they were counted as already read
--    and nobody was alerted.
-- 2. Edited and deleted messages are marked instead of ignored.
-- 3. The connection's ups and downs are kept, and whatsapp_health() tells
--    the screen when messages are arriving late.

alter table whatsapp_messages add column edited_at timestamptz;
alter table whatsapp_messages add column deleted_at timestamptz;

create index if not exists whatsapp_messages_created_idx on whatsapp_messages (created_at desc);

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
           count(*) filter (where not m.from_me and m.created_at > coalesce(r.read_at, '-infinity'::timestamptz)) as unread_count,
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

create or replace function whatsapp_unread_total() returns integer
language sql stable as $$
    select count(*)::integer
    from whatsapp_messages m
    left join whatsapp_reads r on r.remote_jid = m.remote_jid
    where not m.from_me and m.created_at > coalesce(r.read_at, '-infinity'::timestamptz)
$$;

-- Connection changes reported by Evolution (CONNECTION_UPDATE).
create table whatsapp_connection_events (
    id bigint generated always as identity primary key,
    instance text not null,
    state text not null,
    reason text,
    at timestamptz not null default now()
);
create index whatsapp_connection_events_at_idx on whatsapp_connection_events (at desc);
alter table whatsapp_connection_events enable row level security;
create policy whatsapp_connection_events_select on whatsapp_connection_events for select to authenticated using ((select is_staff()));

-- For the WhatsApp screen: how late the messages of the last two hours
-- reached the system (messages sent from the system itself don't count),
-- and the last connection change.
create function whatsapp_health()
returns table (
    last_received_at timestamptz,
    delay_minutes integer,
    late_messages integer,
    last_state text,
    last_state_at timestamptz
)
language sql stable as $$
    select
        (select max(created_at) from whatsapp_messages),
        (select coalesce(max(extract(epoch from created_at - sent_at)) / 60, 0)::integer
           from whatsapp_messages
          where created_at > now() - interval '2 hours' and sent_by is null),
        (select count(*)::integer
           from whatsapp_messages
          where created_at > now() - interval '2 hours' and sent_by is null
            and created_at - sent_at > interval '5 minutes'),
        e.state,
        e.at
    from (select 1) one
    left join lateral (select state, at from whatsapp_connection_events order by at desc limit 1) e on true
$$;
