-- No-show webhook: when a booked patient hasn't been marked as "chegou" some
-- time (default 2 hours) after the booking started, the server POSTs it to
-- the "webhook de falta" set by the super admin in Integrações, once per
-- booking. Same queue pattern as reminders and birthdays (lease, retries,
-- back-off). A Supabase job (pg_cron + pg_net, when available) pings the
-- server every 10 minutes; the daily Vercel cron also drains it as a fallback.

insert into settings (key, value, superadmin_only) values
    ('no_show_webhook_url', 'null', true),
    ('no_show_delay_minutes', '120', true),
    -- The app's address (https://….vercel.app), saved by the Integrações
    -- screen; the database job calls <app_url>/api/cron/faltas.
    ('app_url', 'null', true)
on conflict (key) do nothing;

-- Which bookings count as a no-show right now:
--   * started between delay and delay + 24h ago (older ones are stale: a
--     message about a missed booking days later makes no sense, and turning
--     the webhook on never fires for the whole history);
--   * still "agendado"/"confirmado", or marked "a remarcar"/"não compareceu"
--     (anything but "chegou"); a booking cancelled through the API or taken
--     off the agenda is not a no-show: the patient already told the clinic;
--   * booked before it started (bookings typed in or imported afterwards
--     are records, not appointments someone missed);
--   * the patient accepts messages and has a phone;
--   * the patient has no later booking that holds a slot (already rebooked,
--     or came to another agenda later the same day).
create function no_show_candidates()
returns table (appointment_id uuid, starts_at timestamptz)
language sql stable security definer set search_path = public as $$
    with cfg as (
        select make_interval(mins => greatest(15, setting_int('no_show_delay_minutes', 120))) as delay
    )
    select a.id, a.starts_at
    from appointments a
    cross join cfg
    join patients p on p.id = a.patient_id
    where a.starts_at <= now() - cfg.delay
      and a.starts_at > now() - cfg.delay - interval '24 hours'
      and a.status in ('agendado', 'confirmado', 'pediu_remarcar', 'nao_compareceu')
      and a.removed_at is null
      and a.created_at < a.starts_at
      and p.allow_messages
      and p.phone_digits <> ''
      and not exists (
          select 1 from appointments b
          where b.patient_id = a.patient_id
            and b.id <> a.id
            and b.starts_at > a.starts_at
            and b.removed_at is null
            and appointment_holds_slot(b.status)
      )
$$;

create table no_show_alerts (
    id uuid primary key default gen_random_uuid(),
    appointment_id uuid not null references appointments (id) on delete cascade,
    -- A booking moved to another time and missed again is a new alert.
    starts_at timestamptz not null,
    status text not null default 'pendente' check (status in ('pendente', 'enviado', 'erro', 'ignorado')),
    attempts integer not null default 0,
    next_attempt_at timestamptz not null default now(),
    locked_until timestamptz,
    last_error text,
    sent_at timestamptz,
    created_at timestamptz not null default now(),
    unique (appointment_id, starts_at)
);

-- Read by the team (who was alerted); written only by the server.
alter table no_show_alerts enable row level security;
create policy no_show_alerts_select on no_show_alerts for select to authenticated using ((select is_staff()));

create function claim_no_shows(p_limit integer default 50, p_lease_minutes integer default 10)
returns table (
    alert_id uuid,
    appointment_id uuid,
    patient_id uuid,
    minutes_late integer,
    attempts integer
)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
begin
    insert into no_show_alerts (appointment_id, starts_at)
    select c.appointment_id, c.starts_at from no_show_candidates() c
    on conflict do nothing;

    -- Pending alerts whose booking no longer qualifies (the patient was
    -- marked as arrived, rebooked, the booking was moved or removed, or a
    -- retry fell past the 24-hour window) are dropped instead of sent.
    update no_show_alerts n
    set status = 'ignorado', locked_until = null
    where n.status = 'pendente'
      and not exists (
          select 1 from no_show_candidates() c
          where c.appointment_id = n.appointment_id and c.starts_at = n.starts_at
      )
      and (n.locked_until is null or n.locked_until < now());

    return query
    with due as (
        select n.id
        from no_show_alerts n
        where n.status = 'pendente'
          and n.attempts < 5
          and n.next_attempt_at <= now()
          and (n.locked_until is null or n.locked_until < now())
        order by n.starts_at
        limit p_limit
        for update of n skip locked
    ),
    claimed as (
        update no_show_alerts n
        set locked_until = now() + make_interval(mins => p_lease_minutes), attempts = n.attempts + 1
        from due
        where n.id = due.id
        returning n.*
    )
    select c.id, c.appointment_id, a.patient_id,
           (extract(epoch from now() - a.starts_at) / 60)::integer, c.attempts
    from claimed c
    join appointments a on a.id = c.appointment_id;
end;
$$;

create function mark_no_show_sent(p_alert_id uuid) returns void
language sql security definer set search_path = public as $$
    update no_show_alerts set status = 'enviado', sent_at = now(), locked_until = null, last_error = null
    where id = p_alert_id
$$;

-- Retries come quickly (10, 20, 40, 80 min): the alert is only useful the
-- same day.
create function mark_no_show_failed(p_alert_id uuid, p_error text) returns void
language sql security definer set search_path = public as $$
    update no_show_alerts
    set last_error = left(p_error, 1000),
        locked_until = null,
        status = case when attempts >= 5 then 'erro' else status end,
        next_attempt_at = now() + least(interval '2 hours', interval '10 minutes' * power(2, attempts - 1))
    where id = p_alert_id and status = 'pendente'
$$;

-- ---------------------------------------------------------------------------
-- The database job: every 10 minutes, if the webhook is set and some booking
-- is due, it calls the server's /api/cron/faltas with a token only the
-- database and the server know (the server reads it from here).
-- ---------------------------------------------------------------------------

create schema if not exists private;
revoke all on schema private from public;

drop table if exists private.internal_tokens;
create table private.internal_tokens (
    name text primary key,
    token text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
    created_at timestamptz not null default now()
);
insert into private.internal_tokens (name) values ('cron') on conflict do nothing;

create function ping_no_show_dispatch() returns text
language plpgsql security definer set search_path = public as $$
declare
    v_app text := setting_text('app_url');
    v_hook text := setting_text('no_show_webhook_url');
    v_token text;
begin
    if v_hook is null or v_hook !~ '^https?://' or v_app is null or v_app !~ '^https?://' then
        return 'não configurado';
    end if;
    if not exists (select 1 from no_show_candidates() c
                   where not exists (select 1 from no_show_alerts n where n.appointment_id = c.appointment_id and n.starts_at = c.starts_at))
       and not exists (select 1 from no_show_alerts n
                       where n.status = 'pendente' and n.attempts < 5 and n.next_attempt_at <= now()
                         and (n.locked_until is null or n.locked_until < now())) then
        return 'nada a enviar';
    end if;
    select token into v_token from private.internal_tokens where name = 'cron';
    perform net.http_post(
        url := rtrim(v_app, '/') || '/api/cron/faltas',
        body := '{}'::jsonb,
        headers := jsonb_build_object('content-type', 'application/json', 'x-cron-token', v_token),
        timeout_milliseconds := 60000
    );
    return 'chamado';
end;
$$;

revoke execute on function
    no_show_candidates(), claim_no_shows(integer, integer),
    mark_no_show_sent(uuid), mark_no_show_failed(uuid, text), ping_no_show_dispatch()
from public;

do $$
begin
    if exists (select 1 from pg_roles where rolname = 'anon') then
        revoke all on schema private from anon, authenticated;
        revoke execute on function
            no_show_candidates(), claim_no_shows(integer, integer),
            mark_no_show_sent(uuid), mark_no_show_failed(uuid, text), ping_no_show_dispatch()
        from anon, authenticated;
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
        grant execute on function
            claim_no_shows(integer, integer), mark_no_show_sent(uuid), mark_no_show_failed(uuid, text)
        to service_role;
    end if;

    -- Supabase has pg_cron and pg_net; a plain Postgres (tests) may not.
    if exists (select 1 from pg_available_extensions where name = 'pg_cron')
       and exists (select 1 from pg_available_extensions where name = 'pg_net') then
        create extension if not exists pg_net;
        create extension if not exists pg_cron;
        perform cron.schedule('webhook-faltas', '*/10 * * * *', 'select public.ping_no_show_dispatch()');
    end if;
end;
$$;
