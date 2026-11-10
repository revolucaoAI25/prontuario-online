-- Campaigns ("Disparos"): the super admin sends a webhook per patient to a
-- campaign's own URL (an n8n/Chatflux flow that writes and sends the
-- message), to the whole base or part of it, at a set pace:
--   batch_size messages per window_minutes, gap_min..gap_max seconds apart
--   (random within the range), only between hour_start and hour_end on the
--   chosen weekdays (clinic time).
-- The database job pings the server every 10 seconds when a campaign has a
-- message due; the server claims it (one per campaign per call), posts it and
-- marks it. Patients who opted out of messages or have no phone never enter.

create table campaigns (
    id uuid primary key default gen_random_uuid(),
    name text not null check (btrim(name) <> ''),
    webhook_url text not null check (webhook_url ~ '^https?://'),
    message text,
    status text not null default 'rascunho'
        check (status in ('rascunho', 'enviando', 'pausada', 'concluida', 'cancelada')),
    batch_size integer not null default 20 check (batch_size between 1 and 1000),
    window_minutes integer not null default 60 check (window_minutes between 1 and 1440),
    gap_min_seconds integer not null default 30 check (gap_min_seconds between 0 and 3600),
    gap_max_seconds integer not null default 60 check (gap_max_seconds between 0 and 3600),
    hour_start time not null default '08:00',
    hour_end time not null default '20:00',
    weekdays smallint[] not null default '{1,2,3,4,5,6}',
    audience jsonb not null default '{}',
    next_send_at timestamptz,
    window_started_at timestamptz,
    window_sent integer not null default 0,
    created_by uuid references staff (id) on delete set null,
    created_at timestamptz not null default now(),
    started_at timestamptz,
    finished_at timestamptz,
    check (gap_max_seconds >= gap_min_seconds),
    check (hour_end > hour_start),
    check (cardinality(weekdays) > 0 and weekdays <@ '{0,1,2,3,4,5,6}')
);
create trigger campaigns_set_created_by before insert on campaigns for each row execute function set_created_by();

create table campaign_recipients (
    id uuid primary key default gen_random_uuid(),
    campaign_id uuid not null references campaigns (id) on delete cascade,
    patient_id uuid not null references patients (id) on delete cascade,
    status text not null default 'pendente' check (status in ('pendente', 'enviado', 'erro', 'removido')),
    attempts integer not null default 0,
    locked_until timestamptz,
    last_error text,
    sent_at timestamptz,
    created_at timestamptz not null default now(),
    unique (campaign_id, patient_id)
);
create index campaign_recipients_queue_idx on campaign_recipients (campaign_id, status, created_at);

-- Only the super admin (the agency) sees and runs campaigns.
alter table campaigns enable row level security;
create policy campaigns_superadmin on campaigns for all to authenticated
    using ((select is_superadmin())) with check ((select is_superadmin()));
alter table campaign_recipients enable row level security;
create policy campaign_recipients_superadmin on campaign_recipients for all to authenticated
    using ((select is_superadmin())) with check ((select is_superadmin()));

-- Who a campaign can reach, by filter (all keys optional):
--   agendas: [uuid]          came (chegou) to any of these agendas
--   procedimentos: [uuid]    did any of these procedures
--   veio_nos_ultimos_meses   last visit within N months
--   sem_vir_ha_meses         no visit for more than N months (and came at least once)
--   aniversario_mes          birthday in this month (1-12)
--   idade_min, idade_max
--   sem_agendamento_futuro   nothing booked ahead
--   busca                    part of the name or phone
-- Always: accepts messages and has a phone.
create function campaign_audience(p_filters jsonb default '{}', p_limit integer default null, p_offset integer default 0)
returns table (patient_id uuid, full_name text, phone text, last_visit date, visits integer, total bigint)
language sql stable security definer set search_path = public as $$
    with f as (
        select
            coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(p_filters -> 'agendas') x), '{}') as agendas,
            coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(p_filters -> 'procedimentos') x), '{}') as procedures,
            nullif(p_filters ->> 'veio_nos_ultimos_meses', '')::integer as within_months,
            nullif(p_filters ->> 'sem_vir_ha_meses', '')::integer as lapsed_months,
            nullif(p_filters ->> 'aniversario_mes', '')::integer as birth_month,
            nullif(p_filters ->> 'idade_min', '')::integer as age_min,
            nullif(p_filters ->> 'idade_max', '')::integer as age_max,
            coalesce((p_filters ->> 'sem_agendamento_futuro')::boolean, false) as nothing_ahead,
            nullif(btrim(p_filters ->> 'busca'), '') as search
    ),
    base as (
        select p.id, p.full_name, p.phone, p.birth_date,
               v.last_visit, coalesce(v.visits, 0) as visits
        from patients p
        cross join f
        left join lateral (
            select max((a.starts_at at time zone clinic_tz())::date) as last_visit, count(*)::integer as visits
            from appointments a where a.patient_id = p.id and a.status = 'chegou'
        ) v on true
        where is_superadmin()
          and p.allow_messages and p.phone_digits <> ''
          and (cardinality(f.agendas) = 0 or exists (
              select 1 from appointments a where a.patient_id = p.id and a.status = 'chegou' and a.agenda_id = any (f.agendas)))
          and (cardinality(f.procedures) = 0 or exists (
              select 1 from appointments a join appointment_procedures ap on ap.appointment_id = a.id
              where a.patient_id = p.id and a.status = 'chegou' and ap.procedure_id = any (f.procedures)))
          and (f.within_months is null or v.last_visit >= (clinic_today() - make_interval(months => f.within_months))::date)
          and (f.lapsed_months is null or v.last_visit < (clinic_today() - make_interval(months => f.lapsed_months))::date)
          and (f.birth_month is null or extract(month from p.birth_date) = f.birth_month)
          and (f.age_min is null or p.birth_date <= (clinic_today() - make_interval(years => f.age_min))::date)
          and (f.age_max is null or p.birth_date > (clinic_today() - make_interval(years => f.age_max + 1))::date)
          and (not f.nothing_ahead or not exists (
              select 1 from appointments a where a.patient_id = p.id and a.starts_at > now()
                and a.removed_at is null and a.status in ('agendado', 'confirmado')))
          and (f.search is null or normalize_text(p.full_name) like '%' || normalize_text(f.search) || '%'
               or (regexp_replace(f.search, '\D', '', 'g') <> '' and p.phone_digits like '%' || regexp_replace(f.search, '\D', '', 'g') || '%'))
    )
    select b.id, b.full_name, b.phone, b.last_visit, b.visits, count(*) over () as total
    from base b
    order by b.full_name, b.id
    limit p_limit offset p_offset
$$;

-- Fills a draft campaign's recipients: the filter result minus p_exclude,
-- plus p_include (or only p_include when p_only_included). Opted-out and
-- phoneless patients are skipped either way. Returns how many are queued.
create function set_campaign_recipients(
    p_campaign_id uuid, p_filters jsonb, p_exclude uuid[] default '{}', p_include uuid[] default '{}', p_only_included boolean default false
) returns integer
language plpgsql security definer set search_path = public as $$
declare
    v_count integer;
begin
    if not is_superadmin() then raise exception 'acesso_negado'; end if;
    if not exists (select 1 from campaigns where id = p_campaign_id and status = 'rascunho') then
        raise exception 'campanha_nao_editavel';
    end if;
    delete from campaign_recipients where campaign_id = p_campaign_id;
    insert into campaign_recipients (campaign_id, patient_id)
    select p_campaign_id, x.id
    from (
        select a.patient_id as id from campaign_audience(p_filters) a where not p_only_included
        union
        select p.id from patients p where p.id = any (coalesce(p_include, '{}'))
    ) x
    join patients p on p.id = x.id
    where p.allow_messages and p.phone_digits <> ''
      and not (x.id = any (coalesce(p_exclude, '{}')))
    on conflict do nothing;
    get diagnostics v_count = row_count;
    update campaigns set audience = jsonb_build_object(
        'filtros', coalesce(p_filters, '{}'), 'excluir', to_jsonb(coalesce(p_exclude, '{}')),
        'incluir', to_jsonb(coalesce(p_include, '{}')), 'so_selecionados', p_only_included)
    where id = p_campaign_id;
    return v_count;
end;
$$;

-- Each campaign with how many messages are pending, sent, failed or removed.
create view campaign_progress with (security_invoker = true) as
select c.*,
       count(r.id) filter (where r.status <> 'removido') as total,
       count(r.id) filter (where r.status = 'pendente') as pendentes,
       count(r.id) filter (where r.status = 'enviado') as enviados,
       count(r.id) filter (where r.status = 'erro') as erros,
       max(r.sent_at) as ultimo_envio
from campaigns c
left join campaign_recipients r on r.campaign_id = c.id
group by c.id;

-- Start or resume ('enviando'), pause ('pausada') or cancel ('cancelada').
create function set_campaign_status(p_campaign_id uuid, p_status text) returns campaigns
language plpgsql security definer set search_path = public as $$
declare
    v campaigns;
begin
    if not is_superadmin() then raise exception 'acesso_negado'; end if;
    select * into v from campaigns where id = p_campaign_id for update;
    if v.id is null then raise exception 'campanha_nao_encontrada'; end if;
    if p_status = 'enviando' then
        if v.status not in ('rascunho', 'pausada') then raise exception 'campanha_nao_pode_iniciar'; end if;
        if not exists (select 1 from campaign_recipients where campaign_id = v.id and status = 'pendente') then
            raise exception 'campanha_sem_destinatarios';
        end if;
        update campaigns set status = 'enviando', next_send_at = now(), window_started_at = null, window_sent = 0,
                             started_at = coalesce(started_at, now())
        where id = v.id returning * into v;
    elsif p_status = 'pausada' then
        if v.status <> 'enviando' then raise exception 'campanha_nao_esta_enviando'; end if;
        update campaigns set status = 'pausada', next_send_at = null where id = v.id returning * into v;
    elsif p_status = 'cancelada' then
        if v.status in ('concluida', 'cancelada') then raise exception 'campanha_encerrada'; end if;
        update campaigns set status = 'cancelada', next_send_at = null, finished_at = now() where id = v.id returning * into v;
    else
        raise exception 'status_invalido';
    end if;
    return v;
end;
$$;

-- The next moment the campaign may send, from now (clinic time).
create function campaign_next_open(p_hour_start time, p_hour_end time, p_weekdays smallint[]) returns timestamptz
language plpgsql stable set search_path = public as $$
declare
    v_local timestamp := now() at time zone clinic_tz();
    v_day date;
    i integer;
begin
    for i in 0..7 loop
        v_day := v_local::date + i;
        if extract(dow from v_day)::smallint = any (p_weekdays) then
            if i > 0 or v_local::time < p_hour_start then
                return local_timestamp(v_day, p_hour_start);
            elsif v_local::time < p_hour_end then
                return now();
            end if;
        end if;
    end loop;
    return null;
end;
$$;

-- One due message per sending campaign (the pace keeps them apart). Moves
-- the campaign's clock: the next gap, or the next window once the batch is
-- done, or the next allowed hour. Finishes campaigns with nothing left.
create function claim_campaign_messages(p_lease_seconds integer default 120)
returns table (
    recipient_id uuid, campaign_id uuid, campaign_name text, campaign_message text,
    webhook_url text, patient_id uuid, attempts integer
)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
    c campaigns;
    v_open timestamptz;
    r campaign_recipients;
    v_window_start timestamptz;
    v_sent integer;
begin
    for c in
        select * from campaigns
        where status = 'enviando' and next_send_at <= now()
        order by next_send_at
        for update skip locked
    loop
        v_open := campaign_next_open(c.hour_start, c.hour_end, c.weekdays);
        if v_open is null or v_open > now() then
            update campaigns set next_send_at = v_open where id = c.id;
            continue;
        end if;

        select * into r from campaign_recipients cr
        where cr.campaign_id = c.id and cr.status = 'pendente'
          and (cr.locked_until is null or cr.locked_until < now())
        order by cr.created_at, cr.id
        limit 1
        for update skip locked;

        if r.id is null then
            if not exists (select 1 from campaign_recipients cr where cr.campaign_id = c.id and cr.status = 'pendente') then
                update campaigns set status = 'concluida', next_send_at = null, finished_at = now() where id = c.id;
            else
                update campaigns set next_send_at = now() + interval '1 minute' where id = c.id;
            end if;
            continue;
        end if;

        update campaign_recipients set locked_until = now() + make_interval(secs => p_lease_seconds), attempts = attempts + 1
        where id = r.id;

        if c.window_started_at is null or now() >= c.window_started_at + make_interval(mins => c.window_minutes) then
            v_window_start := now();
            v_sent := 1;
        else
            v_window_start := c.window_started_at;
            v_sent := c.window_sent + 1;
        end if;
        update campaigns
        set window_started_at = v_window_start,
            window_sent = v_sent,
            next_send_at = case
                when v_sent >= c.batch_size then v_window_start + make_interval(mins => c.window_minutes)
                else now() + make_interval(secs => c.gap_min_seconds + floor(random() * (c.gap_max_seconds - c.gap_min_seconds + 1))::integer)
            end
        where id = c.id;

        recipient_id := r.id; campaign_id := c.id; campaign_name := c.name; campaign_message := c.message;
        webhook_url := c.webhook_url; patient_id := r.patient_id; attempts := r.attempts + 1;
        return next;
    end loop;
end;
$$;

create function mark_campaign_sent(p_recipient_id uuid) returns void
language sql security definer set search_path = public as $$
    update campaign_recipients set status = 'enviado', sent_at = now(), locked_until = null, last_error = null
    where id = p_recipient_id;
    update campaigns c set status = 'concluida', next_send_at = null, finished_at = now()
    where c.id = (select campaign_id from campaign_recipients where id = p_recipient_id)
      and c.status = 'enviando'
      and not exists (select 1 from campaign_recipients r where r.campaign_id = c.id and r.status = 'pendente');
$$;

-- A failed post goes back to the queue (tried again 5 minutes later, in the
-- campaign's pace); after 3 attempts it stays as 'erro'.
create function mark_campaign_failed(p_recipient_id uuid, p_error text) returns void
language sql security definer set search_path = public as $$
    update campaign_recipients
    set last_error = left(p_error, 1000),
        status = case when attempts >= 3 then 'erro' else 'pendente' end,
        locked_until = case when attempts >= 3 then null else now() + interval '5 minutes' end
    where id = p_recipient_id;
$$;

-- The database job: calls the server when some campaign has a message due.
create function ping_campaign_dispatch() returns text
language plpgsql security definer set search_path = public as $$
declare
    v_app text := setting_text('app_url');
    v_token text;
begin
    if not exists (select 1 from campaigns where status = 'enviando' and next_send_at <= now()) then
        return 'nada a enviar';
    end if;
    if v_app is null or v_app !~ '^https?://' then return 'não configurado'; end if;
    select token into v_token from private.internal_tokens where name = 'cron';
    perform net.http_post(
        url := rtrim(v_app, '/') || '/api/cron/campanhas',
        body := '{}'::jsonb,
        headers := jsonb_build_object('content-type', 'application/json', 'x-cron-token', v_token),
        timeout_milliseconds := 60000
    );
    return 'chamado';
end;
$$;

revoke execute on function
    claim_campaign_messages(integer), mark_campaign_sent(uuid), mark_campaign_failed(uuid, text), ping_campaign_dispatch()
from public;

do $$
begin
    if exists (select 1 from pg_roles where rolname = 'anon') then
        revoke execute on function
            claim_campaign_messages(integer), mark_campaign_sent(uuid), mark_campaign_failed(uuid, text), ping_campaign_dispatch(),
            campaign_audience(jsonb, integer, integer), set_campaign_recipients(uuid, jsonb, uuid[], uuid[], boolean),
            set_campaign_status(uuid, text)
        from anon;
        revoke execute on function
            claim_campaign_messages(integer), mark_campaign_sent(uuid), mark_campaign_failed(uuid, text), ping_campaign_dispatch()
        from authenticated;
    end if;
    -- Every 10 seconds, where pg_cron and pg_net are installed (Supabase).
    if exists (select 1 from pg_extension where extname = 'pg_cron')
       and exists (select 1 from pg_extension where extname = 'pg_net') then
        perform cron.schedule('disparos-campanhas', '10 seconds', 'select public.ping_campaign_dispatch()');
    end if;
end;
$$;
