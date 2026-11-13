-- WhatsApp watchdog. Every 2 minutes the database calls the server
-- (/api/cron/whatsapp), which:
--   * fetches from Evolution any message of the last hours that the webhook
--     didn't deliver;
--   * spots a stuck connection (Evolution says "connected" but nothing
--     arrives during opening hours, or what arrives is late) and restarts
--     it, which also pulls the late messages;
--   * when restarting doesn't help, tells the team to read the QR Code
--     again (banner on every screen).
-- The outcome of the last check is kept here for the screens.

create table whatsapp_watchdog (
    id integer primary key default 1 check (id = 1),
    checked_at timestamptz,
    state text,
    -- ok | atrasado (catching up) | travado (restarted, waiting)
    -- | desconectado | precisa_reconectar | nao_configurado
    status text not null default 'ok',
    detail text,
    last_arrival_at timestamptz,
    restarts timestamptz[] not null default '{}',
    last_sync_added integer not null default 0,
    last_sync_at timestamptz
);
insert into whatsapp_watchdog (id) values (1) on conflict do nothing;
alter table whatsapp_watchdog enable row level security;
create policy whatsapp_watchdog_select on whatsapp_watchdog for select to authenticated using ((select is_staff()));

drop function if exists whatsapp_health();
create function whatsapp_health()
returns table (
    last_received_at timestamptz,
    delay_minutes integer,
    late_messages integer,
    last_state text,
    last_state_at timestamptz,
    watch_status text,
    watch_detail text,
    watch_checked_at timestamptz,
    last_restart_at timestamptz,
    restarts_last_hour integer
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
        e.at,
        w.status,
        w.detail,
        w.checked_at,
        (select max(r) from unnest(w.restarts) r),
        (select count(*)::integer from unnest(w.restarts) r where r > now() - interval '1 hour')
    from (select 1) one
    left join lateral (select state, at from whatsapp_connection_events order by at desc limit 1) e on true
    left join whatsapp_watchdog w on w.id = 1
$$;

create function ping_whatsapp_watchdog() returns text
language plpgsql security definer set search_path = public as $$
declare
    v_app text := setting_text('app_url');
    v_token text;
begin
    if v_app is null or v_app !~ '^https?://' then return 'não configurado'; end if;
    select token into v_token from private.internal_tokens where name = 'cron';
    perform net.http_post(
        url := rtrim(v_app, '/') || '/api/cron/whatsapp',
        body := '{}'::jsonb,
        headers := jsonb_build_object('content-type', 'application/json', 'x-cron-token', v_token),
        timeout_milliseconds := 60000
    );
    return 'chamado';
end;
$$;
revoke execute on function ping_whatsapp_watchdog() from public;

do $$
begin
    if exists (select 1 from pg_roles where rolname = 'anon') then
        revoke execute on function ping_whatsapp_watchdog() from anon, authenticated;
    end if;
    if exists (select 1 from pg_extension where extname = 'pg_cron') then
        perform cron.schedule('whatsapp-vigia', '*/2 * * * *', 'select public.ping_whatsapp_watchdog()');
    end if;
end;
$$;
