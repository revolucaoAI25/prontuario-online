-- =====================================================================
-- Banco da Clínica Rezeck — instalação completa (migrações + dados iniciais)
--
-- Gerado por scripts/build-setup-sql.mjs a partir de supabase/migrations e
-- supabase/seed.sql. Não edite à mão.
--
-- Cole TUDO no SQL Editor do Supabase e clique em Run. Pode rodar de novo se
-- der erro no meio: o começo apaga o que uma tentativa anterior deixou.
-- Se o banco já tiver pacientes, nada é executado (não apaga dados reais).
-- =====================================================================

do $$
declare
    has_patients boolean := false;
begin
    if to_regclass('public.patients') is not null then
        execute 'select exists (select 1 from public.patients)' into has_patients;
    end if;
    if has_patients then
        raise exception 'Este banco já tem pacientes. setup.sql é só para a instalação inicial e não foi executado.';
    end if;
end;
$$;

-- Limpa uma tentativa anterior (só objetos deste sistema, no schema public).
drop view if exists public.campaign_progress, public.stock_levels, public.whatsapp_conversations cascade;
drop table if exists public.admin_notes, public.admin_tasks, public.agenda_blocks, public.agenda_hours, public.agenda_openings, public.agenda_slot_times, public.agendas, public.appointment_procedures, public.appointment_types, public.appointments, public.birthday_messages, public.campaign_recipients, public.campaigns, public.chat_channel_members, public.chat_channels, public.chat_messages, public.chat_reads, public.employee_vacations, public.employees, public.expenses, public.finance_pin, public.finance_pin_attempts, public.no_show_alerts, public.note_shortcuts, public.patient_legacy_aliases, public.patient_not_duplicates, public.patients, public.payments, public.private, public.procedures, public.record_attachments, public.record_entries, public.record_entry_revisions, public.reminder_recalc_queue, public.reminders, public.settings, public.staff, public.staff_finance_pins, public.stock_movements, public.stock_products, public.stock_sectors, public.whatsapp_connection_events, public.whatsapp_lid_map, public.whatsapp_messages, public.whatsapp_reads, public.whatsapp_watchdog cascade;
drop type if exists public.appointment_status, public.payment_method, public.payment_status, public.reminder_status, public.staff_role, public.stock_movement_type cascade;
do $$
declare
    r record;
begin
    for r in
        select p.oid::regprocedure as fn
        from pg_proc p
        where p.pronamespace = 'public'::regnamespace
          and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
    loop
        execute 'drop function if exists ' || r.fn || ' cascade';
    end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- supabase/migrations/20261027000001_base.sql
-- ---------------------------------------------------------------------

-- Base: extensions, staff/roles, settings and shared helpers.

create schema if not exists extensions;
create extension if not exists unaccent with schema extensions;
create extension if not exists pg_trgm with schema extensions;

create type staff_role as enum ('admin', 'secretaria', 'profissional');

-- One row per person working at the clinic; id is the Supabase Auth user id.
create table staff (
    id uuid primary key references auth.users (id) on delete cascade,
    full_name text not null,
    role staff_role not null default 'secretaria',
    agenda_id uuid,
    active boolean not null default true,
    created_at timestamptz not null default now()
);

create table settings (
    key text primary key,
    value jsonb not null,
    updated_at timestamptz not null default now()
);

insert into settings (key, value) values
    ('default_reminder_months', '6'),
    ('reminder_max_overdue_days', '30'),
    ('reminder_webhook_url', 'null'),
    ('birthday_webhook_url', 'null');

create function clinic_tz() returns text
language sql immutable parallel safe as $$ select 'America/Sao_Paulo' $$;

create function clinic_today() returns date
language sql stable as $$ select (now() at time zone public.clinic_tz())::date $$;

create function normalize_text(t text) returns text
language sql immutable parallel safe as $$
    select lower(extensions.unaccent('extensions.unaccent'::regdictionary, coalesce(t, '')))
$$;

create function only_digits(t text) returns text
language sql immutable parallel safe as $$ select regexp_replace(coalesce(t, ''), '\D', '', 'g') $$;

-- Brazilian phone key: DDD + last 8 digits. Ignores the country code and the
-- optional 9th mobile digit, which WhatsApp JIDs and typed numbers disagree on.
-- Used in indexes: Postgres 17 builds those with an empty search_path, so
-- calls to our own functions must be schema-qualified.
create function phone_key(digits text) returns text
language sql immutable parallel safe as $$
    select case
        when length(d) >= 10 then left(d, 2) || right(d, 8)
        else null
    end
    from (
        select case
            when length(public.only_digits(digits)) >= 12 and left(public.only_digits(digits), 2) = '55'
                then substr(public.only_digits(digits), 3)
            else ltrim(public.only_digits(digits), '0')
        end as d
    ) s
$$;

create function set_updated_at() returns trigger
language plpgsql as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

create function current_staff_role() returns staff_role
language sql stable security definer set search_path = public as $$
    select role from staff where id = auth.uid() and active
$$;

create function is_staff() returns boolean
language sql stable as $$ select current_staff_role() is not null $$;

create function is_admin() returns boolean
language sql stable as $$ select current_staff_role() = 'admin' $$;

-- Settings are admin-only under RLS, but triggers and functions running as
-- any staff member need to read them.
create function setting_int(p_key text, p_default integer) returns integer
language sql stable security definer set search_path = public as $$
    select coalesce((select (value #>> '{}')::integer from settings where key = p_key), p_default)
$$;

create function setting_text(p_key text) returns text
language sql stable security definer set search_path = public as $$
    select value #>> '{}' from settings where key = p_key
$$;

-- ---------------------------------------------------------------------
-- supabase/migrations/20261027000002_patients_records.sql
-- ---------------------------------------------------------------------

-- Patients and the medical record ("prontuário"): a dated notepad per patient.

create table patients (
    id uuid primary key default gen_random_uuid(),
    full_name text not null check (btrim(full_name) <> ''),
    cpf text,
    email text,
    phone text,
    phone_alt text,
    phone_digits text generated always as (only_digits(phone)) stored,
    profession text,
    birth_date date,
    address text,
    notes text,
    -- LGPD opt-out / deceased: never send reminders or birthday messages.
    allow_messages boolean not null default true,
    legacy_id integer unique,
    legacy_raw jsonb,
    -- last time the FastClinic import wrote this row; a re-import skips rows
    -- edited in the new system after that
    legacy_synced_at timestamptz,
    created_by uuid references staff (id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index patients_name_trgm_idx on patients using gin (normalize_text(full_name) extensions.gin_trgm_ops);
create index patients_phone_key_idx on patients (phone_key(phone));
create index patients_phone_alt_key_idx on patients (phone_key(phone_alt));
create index patients_cpf_idx on patients (only_digits(cpf));
create index patients_birthday_idx on patients (extract(month from birth_date), extract(day from birth_date));

create trigger patients_set_updated_at before update on patients
for each row execute function set_updated_at();

create table record_entries (
    id uuid primary key default gen_random_uuid(),
    patient_id uuid not null references patients (id) on delete cascade,
    entry_at timestamptz not null default now(),
    content text not null check (btrim(content) <> ''),
    author_id uuid references staff (id) on delete set null,
    appointment_id uuid,
    legacy_id integer unique,
    legacy_synced_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index record_entries_patient_idx on record_entries (patient_id, entry_at desc);
create index record_entries_content_trgm_idx on record_entries using gin (normalize_text(content) extensions.gin_trgm_ops);

create trigger record_entries_set_updated_at before update on record_entries
for each row execute function set_updated_at();

create table record_attachments (
    id uuid primary key default gen_random_uuid(),
    entry_id uuid not null references record_entries (id) on delete cascade,
    patient_id uuid not null references patients (id) on delete cascade,
    storage_path text not null unique,
    file_name text not null,
    mime_type text,
    size_bytes bigint,
    created_by uuid references staff (id) on delete set null,
    created_at timestamptz not null default now()
);

create index record_attachments_entry_idx on record_attachments (entry_id);

-- Letter buttons in the record composer (L = Limpeza, LC1 = Loção clareadora 1, ...).
create table note_shortcuts (
    id uuid primary key default gen_random_uuid(),
    label text not null unique,
    insert_text text not null,
    kind text not null default 'procedimento' check (kind in ('procedimento', 'produto')),
    sort_order integer not null default 0,
    active boolean not null default true
);

-- Name / phone / CPF search used by the patients list, the agenda and the
-- record screen. When p_include_records is true it also matches text inside
-- the patient's record entries.
--
-- Security definer on purpose: under RLS Postgres cannot use the trigram
-- indexes for these expressions (non-leakproof functions), which made the
-- record-text search scan all entries. Access is checked here instead: app
-- users must be staff; direct server connections (no JWT) are trusted.
create function search_patients(p_query text, p_limit integer default 30, p_include_records boolean default false)
returns setof patients
language plpgsql stable security definer set search_path = public as $$
declare
    v_claims text := nullif(current_setting('request.jwt.claims', true), '');
    v_text text := normalize_text(btrim(p_query));
    v_like text := '%' || normalize_text(btrim(p_query)) || '%';
    v_digits text := only_digits(p_query);
begin
    if v_claims is not null and (v_claims::jsonb ->> 'role') is distinct from 'service_role' and not is_staff() then
        return;
    end if;
    if v_text = '' then
        return;
    end if;
    return query
    select p.*
    from patients p
    where normalize_text(p.full_name) like v_like
       or (length(v_digits) >= 4 and (
            p.phone_digits like '%' || v_digits || '%'
            or only_digits(p.phone_alt) like '%' || v_digits || '%'
            or only_digits(p.cpf) like '%' || v_digits || '%'
       ))
       or (p_include_records and p.id in (
            select r.patient_id from record_entries r where normalize_text(r.content) like v_like
       ))
    order by (normalize_text(p.full_name) like v_text || '%') desc, p.full_name
    limit p_limit;
end;
$$;

revoke execute on function search_patients(text, integer, boolean) from public;
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
        revoke execute on function search_patients(text, integer, boolean) from anon;
        grant execute on function search_patients(text, integer, boolean) to authenticated, service_role;
    end if;
end;
$$;

-- ---------------------------------------------------------------------
-- supabase/migrations/20261027000003_scheduling.sql
-- ---------------------------------------------------------------------

-- Agendas, working hours, blocks, appointment types, procedures and appointments.

create type appointment_status as enum (
    'agendado',         -- amarelo claro: marcado, paciente ainda não confirmou
    'confirmado',       -- bege: paciente confirmou
    'chegou',           -- marrom: paciente compareceu (dispara os lembretes)
    'pediu_remarcar',   -- rosa: pediu para remarcar e ainda não remarcou
    'nao_compareceu',   -- azul pastel
    'cancelado'
);

-- Statuses that keep a time slot occupied for automated booking. A patient
-- who asked to reschedule, cancelled or didn't show up no longer holds it.
create function appointment_holds_slot(s appointment_status) returns boolean
language sql immutable parallel safe as $$ select s in ('agendado', 'confirmado', 'chegou') $$;

create table agendas (
    id uuid primary key default gen_random_uuid(),
    name text not null unique,
    color text not null default '#0F5C66',
    slot_step_minutes integer not null default 30 check (slot_step_minutes between 5 and 240),
    sort_order integer not null default 0,
    active boolean not null default true,
    created_at timestamptz not null default now()
);

alter table staff add constraint staff_agenda_id_fkey
    foreign key (agenda_id) references agendas (id) on delete set null;

-- Weekly opening hours. Several rows on the same weekday make a lunch break.
create table agenda_hours (
    id uuid primary key default gen_random_uuid(),
    agenda_id uuid not null references agendas (id) on delete cascade,
    weekday smallint not null check (weekday between 0 and 6), -- 0 = domingo
    start_time time not null,
    end_time time not null,
    check (end_time > start_time)
);

create index agenda_hours_agenda_idx on agenda_hours (agenda_id, weekday);

-- Optional fixed start times for a weekday (the clinic's "horários quebrados",
-- e.g. 13:30, 14:00, 14:40, 15:15). When a weekday has any, availability
-- offers exactly these; otherwise it walks the opening hours every
-- slot_step_minutes.
create table agenda_slot_times (
    agenda_id uuid not null references agendas (id) on delete cascade,
    weekday smallint not null check (weekday between 0 and 6),
    start_time time not null,
    primary key (agenda_id, weekday, start_time)
);

-- Closed periods: a whole day off, a holiday (agenda_id null = whole clinic),
-- or a few hours blocked.
create table agenda_blocks (
    id uuid primary key default gen_random_uuid(),
    agenda_id uuid references agendas (id) on delete cascade,
    starts_at timestamptz not null,
    ends_at timestamptz not null,
    reason text,
    created_by uuid references staff (id) on delete set null,
    legacy_id integer unique,
    created_at timestamptz not null default now(),
    check (ends_at > starts_at)
);

create index agenda_blocks_time_idx on agenda_blocks (starts_at, ends_at);

create table appointment_types (
    id uuid primary key default gen_random_uuid(),
    agenda_id uuid not null references agendas (id) on delete cascade,
    name text not null,
    duration_minutes integer not null check (duration_minutes between 5 and 600),
    is_default boolean not null default false,
    active boolean not null default true,
    sort_order integer not null default 0,
    unique (agenda_id, name)
);

create unique index appointment_types_one_default_idx on appointment_types (agenda_id) where is_default;

create table procedures (
    id uuid primary key default gen_random_uuid(),
    name text not null check (btrim(name) <> ''),
    -- null = use settings.default_reminder_months
    reminder_months integer check (reminder_months between 1 and 60),
    active boolean not null default true,
    created_at timestamptz not null default now()
);

create unique index procedures_name_idx on procedures (normalize_text(btrim(name)));

create table appointments (
    id uuid primary key default gen_random_uuid(),
    agenda_id uuid not null references agendas (id),
    appointment_type_id uuid references appointment_types (id) on delete set null,
    patient_id uuid not null references patients (id) on delete cascade,
    starts_at timestamptz not null,
    ends_at timestamptz not null,
    status appointment_status not null default 'agendado',
    status_changed_at timestamptz not null default now(),
    notes text,
    cancel_reason text,
    source text not null default 'sistema' check (source in ('sistema', 'api', 'legado')),
    created_by uuid references staff (id) on delete set null,
    updated_by uuid references staff (id) on delete set null,
    legacy_id integer unique,
    legacy_synced_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check (ends_at > starts_at)
);

create index appointments_agenda_time_idx on appointments (agenda_id, starts_at);
create index appointments_patient_idx on appointments (patient_id, starts_at desc);
create index appointments_starts_at_idx on appointments (starts_at);

alter table record_entries add constraint record_entries_appointment_id_fkey
    foreign key (appointment_id) references appointments (id) on delete set null;

create function appointments_before_update() returns trigger
language plpgsql as $$
begin
    new.updated_at = now();
    new.updated_by = coalesce(auth.uid(), new.updated_by);
    if new.status is distinct from old.status then
        new.status_changed_at = now();
    end if;
    return new;
end;
$$;

create trigger appointments_before_update before update on appointments
for each row execute function appointments_before_update();

create table appointment_procedures (
    appointment_id uuid not null references appointments (id) on delete cascade,
    procedure_id uuid not null references procedures (id) on delete restrict,
    primary key (appointment_id, procedure_id)
);

create index appointment_procedures_procedure_idx on appointment_procedures (procedure_id);

-- ---------------------------------------------------------------------------
-- Scheduling logic. The HTTP API calls these; the app's screens may also
-- insert/update appointments directly (manual overlap is allowed there, as
-- the aesthetics room has 4 beds). Errors are raised with a stable code as
-- the message so the API can translate them.
-- ---------------------------------------------------------------------------

create function local_timestamp(p_date date, p_time time) returns timestamptz
language sql immutable parallel safe as $$ select (p_date + p_time) at time zone clinic_tz() $$;

create function fits_working_hours(p_agenda_id uuid, p_starts_at timestamptz, p_ends_at timestamptz)
returns boolean
language sql stable as $$
    select exists (
        select 1
        from agenda_hours h
        where h.agenda_id = p_agenda_id
          and h.weekday = extract(dow from (p_starts_at at time zone clinic_tz()))
          and p_starts_at >= local_timestamp((p_starts_at at time zone clinic_tz())::date, h.start_time)
          and p_ends_at <= local_timestamp((p_starts_at at time zone clinic_tz())::date, h.end_time)
    ) or exists (
        select 1
        from agenda_slot_times st
        where st.agenda_id = p_agenda_id
          and st.weekday = extract(dow from (p_starts_at at time zone clinic_tz()))
          and st.start_time = (p_starts_at at time zone clinic_tz())::time
    )
$$;

-- Default end of a booking. On a configured fixed start time the slot lasts
-- until the next fixed start (13:30 → 14:00 → 14:40), capped by the type's
-- duration; otherwise it is simply start + duration.
create function default_end(p_agenda_id uuid, p_starts_at timestamptz, p_duration_minutes integer)
returns timestamptz
language sql stable as $$
    select least(
        p_starts_at + make_interval(mins => p_duration_minutes),
        coalesce((
            select local_timestamp((p_starts_at at time zone clinic_tz())::date, min(nxt.start_time))
            from agenda_slot_times nxt
            where nxt.agenda_id = p_agenda_id
              and nxt.weekday = extract(dow from (p_starts_at at time zone clinic_tz()))
              and nxt.start_time > (p_starts_at at time zone clinic_tz())::time
              and exists (
                  select 1 from agenda_slot_times cur
                  where cur.agenda_id = p_agenda_id
                    and cur.weekday = nxt.weekday
                    and cur.start_time = (p_starts_at at time zone clinic_tz())::time
              )
        ), 'infinity'::timestamptz)
    )
$$;

create function slot_is_taken(
    p_agenda_id uuid,
    p_starts_at timestamptz,
    p_ends_at timestamptz,
    p_ignore_appointment_id uuid default null
) returns boolean
language sql stable as $$
    select exists (
        select 1 from appointments a
        where a.agenda_id = p_agenda_id
          and appointment_holds_slot(a.status)
          and a.starts_at < p_ends_at
          and a.ends_at > p_starts_at
          and a.id is distinct from p_ignore_appointment_id
    ) or exists (
        select 1 from agenda_blocks b
        where (b.agenda_id = p_agenda_id or b.agenda_id is null)
          and b.starts_at < p_ends_at
          and b.ends_at > p_starts_at
    )
$$;

-- Free slots for one day. Duration comes from p_duration_minutes, else the
-- given type, else the agenda's default type. Slots start every
-- slot_step_minutes from each opening window.
create function available_slots(
    p_date date,
    p_agenda_id uuid default null,
    p_appointment_type_id uuid default null,
    p_duration_minutes integer default null
)
returns table (
    agenda_id uuid,
    agenda_name text,
    appointment_type_id uuid,
    starts_at timestamptz,
    ends_at timestamptz
)
language sql stable as $$
    with ag as (
        select a.id, a.name, a.sort_order, a.slot_step_minutes, t.id as type_id,
               coalesce(p_duration_minutes, t.duration_minutes, 30) as duration
        from agendas a
        left join lateral (
            select at.id, at.duration_minutes
            from appointment_types at
            where at.agenda_id = a.id and at.active
              and case when p_appointment_type_id is null then at.is_default
                       else at.id = p_appointment_type_id end
            limit 1
        ) t on true
        where a.active
          and (p_agenda_id is null or a.id = p_agenda_id)
          and (p_appointment_type_id is null or t.id is not null)
    ),
    fixed as (
        select ag.id, ag.name, ag.sort_order, ag.type_id,
               local_timestamp(p_date, st.start_time) as slot_start, ag.duration
        from ag
        join agenda_slot_times st on st.agenda_id = ag.id and st.weekday = extract(dow from p_date)
    ),
    walked as (
        select ag.id, ag.name, ag.sort_order, ag.type_id, s.slot_start, ag.duration
        from ag
        join agenda_hours h on h.agenda_id = ag.id and h.weekday = extract(dow from p_date)
        cross join lateral generate_series(
            local_timestamp(p_date, h.start_time),
            local_timestamp(p_date, h.end_time) - make_interval(mins => ag.duration),
            make_interval(mins => ag.slot_step_minutes)
        ) as s(slot_start)
        where not exists (select 1 from fixed f where f.id = ag.id)
    ),
    candidates as (
        select c.id, c.name, c.sort_order, c.type_id, c.slot_start,
               default_end(c.id, c.slot_start, c.duration) as slot_end
        from (select * from fixed union all select * from walked) c
    )
    select c.id, c.name, c.type_id, c.slot_start, c.slot_end
    from candidates c
    where c.slot_start > now()
      and not slot_is_taken(c.id, c.slot_start, c.slot_end)
    order by c.sort_order, c.name, c.slot_start
$$;

-- Finds a procedure by name (accent/case-insensitive) or registers it; a new
-- one gets the default reminder period.
create function ensure_procedure(p_name text) returns uuid
language plpgsql as $$
declare
    v_id uuid;
begin
    if p_name is null or btrim(p_name) = '' then
        return null;
    end if;
    select id into v_id from procedures where normalize_text(btrim(name)) = normalize_text(btrim(p_name));
    if v_id is null then
        insert into procedures (name) values (btrim(p_name))
        on conflict ((normalize_text(btrim(name)))) do nothing
        returning id into v_id;
        if v_id is null then
            select id into v_id from procedures where normalize_text(btrim(name)) = normalize_text(btrim(p_name));
        end if;
    end if;
    return v_id;
end;
$$;

create function add_appointment_procedures(p_appointment_id uuid, p_names text[]) returns void
language sql as $$
    insert into appointment_procedures (appointment_id, procedure_id)
    select p_appointment_id, s.procedure_id
    from (select ensure_procedure(n) as procedure_id from unnest(coalesce(p_names, '{}'::text[])) as n) s
    where s.procedure_id is not null
    on conflict do nothing
$$;

create function lock_agenda(p_agenda_id uuid) returns void
language sql as $$ select pg_advisory_xact_lock(hashtextextended('agenda:' || p_agenda_id::text, 0)) $$;

create function book_appointment(
    p_agenda_id uuid,
    p_patient_id uuid,
    p_starts_at timestamptz,
    p_ends_at timestamptz default null,
    p_appointment_type_id uuid default null,
    p_notes text default null,
    p_procedure_names text[] default null,
    p_source text default 'api',
    p_enforce_rules boolean default true
) returns appointments
language plpgsql as $$
declare
    v_type appointment_types;
    v_ends_at timestamptz;
    v_appointment appointments;
begin
    perform lock_agenda(p_agenda_id);

    if not exists (select 1 from agendas where id = p_agenda_id and active) then
        raise exception 'agenda_nao_encontrada';
    end if;
    if not exists (select 1 from patients where id = p_patient_id) then
        raise exception 'paciente_nao_encontrado';
    end if;

    if p_appointment_type_id is not null then
        select * into v_type from appointment_types
        where id = p_appointment_type_id and agenda_id = p_agenda_id and active;
        if not found then
            raise exception 'tipo_invalido_para_agenda';
        end if;
    else
        select * into v_type from appointment_types
        where agenda_id = p_agenda_id and is_default and active;
    end if;

    v_ends_at := coalesce(p_ends_at, default_end(p_agenda_id, p_starts_at, coalesce(v_type.duration_minutes, 30)));
    if v_ends_at <= p_starts_at then
        raise exception 'horario_invalido';
    end if;

    if p_enforce_rules then
        if p_starts_at <= now() then
            raise exception 'horario_no_passado';
        end if;
        if not fits_working_hours(p_agenda_id, p_starts_at, v_ends_at) then
            raise exception 'fora_do_horario_de_atendimento';
        end if;
        if slot_is_taken(p_agenda_id, p_starts_at, v_ends_at) then
            raise exception 'horario_indisponivel';
        end if;
    end if;

    insert into appointments (agenda_id, appointment_type_id, patient_id, starts_at, ends_at, notes, source)
    values (p_agenda_id, v_type.id, p_patient_id, p_starts_at, v_ends_at, p_notes, p_source)
    returning * into v_appointment;

    perform add_appointment_procedures(v_appointment.id, p_procedure_names);
    return v_appointment;
end;
$$;

create function confirm_appointment(p_appointment_id uuid) returns appointments
language plpgsql as $$
declare
    v_appointment appointments;
begin
    select * into v_appointment from appointments where id = p_appointment_id for update;
    if not found then
        raise exception 'agendamento_nao_encontrado';
    end if;
    if v_appointment.status = 'cancelado' then
        raise exception 'agendamento_cancelado';
    end if;
    if v_appointment.status in ('agendado', 'pediu_remarcar') then
        update appointments set status = 'confirmado' where id = p_appointment_id
        returning * into v_appointment;
    end if;
    return v_appointment;
end;
$$;

create function cancel_appointment(p_appointment_id uuid, p_reason text default null) returns appointments
language plpgsql as $$
declare
    v_appointment appointments;
begin
    select * into v_appointment from appointments where id = p_appointment_id for update;
    if not found then
        raise exception 'agendamento_nao_encontrado';
    end if;
    if v_appointment.status = 'chegou' then
        raise exception 'agendamento_ja_realizado';
    end if;
    if v_appointment.status <> 'cancelado' then
        update appointments set status = 'cancelado', cancel_reason = p_reason where id = p_appointment_id
        returning * into v_appointment;
    end if;
    return v_appointment;
end;
$$;

-- Moves an appointment (keeping its duration unless a new end is given),
-- optionally to another agenda. It goes back to 'agendado' because the
-- patient hasn't confirmed the new time yet.
create function reschedule_appointment(
    p_appointment_id uuid,
    p_new_starts_at timestamptz,
    p_new_ends_at timestamptz default null,
    p_new_agenda_id uuid default null,
    p_enforce_rules boolean default true
) returns appointments
language plpgsql as $$
declare
    v_appointment appointments;
    v_agenda_id uuid;
    v_type_id uuid;
    v_ends_at timestamptz;
begin
    select * into v_appointment from appointments where id = p_appointment_id;
    if not found then
        raise exception 'agendamento_nao_encontrado';
    end if;

    v_agenda_id := coalesce(p_new_agenda_id, v_appointment.agenda_id);
    perform lock_agenda(v_agenda_id);
    select * into v_appointment from appointments where id = p_appointment_id for update;

    if v_appointment.status = 'cancelado' then
        raise exception 'agendamento_cancelado';
    end if;
    if v_appointment.status = 'chegou' then
        raise exception 'agendamento_ja_realizado';
    end if;
    if not exists (select 1 from agendas where id = v_agenda_id and active) then
        raise exception 'agenda_nao_encontrada';
    end if;

    v_type_id := v_appointment.appointment_type_id;
    if v_agenda_id <> v_appointment.agenda_id then
        select id into v_type_id from appointment_types where agenda_id = v_agenda_id and is_default and active;
    end if;

    -- Without an explicit end, take the type's length (or keep the current
    -- one), trimmed to the slot when landing on a fixed start time.
    v_ends_at := coalesce(p_new_ends_at, default_end(
        v_agenda_id,
        p_new_starts_at,
        coalesce(
            (select duration_minutes from appointment_types where id = v_type_id),
            (extract(epoch from v_appointment.ends_at - v_appointment.starts_at) / 60)::integer
        )
    ));
    if v_ends_at <= p_new_starts_at then
        raise exception 'horario_invalido';
    end if;

    if p_enforce_rules then
        if p_new_starts_at <= now() then
            raise exception 'horario_no_passado';
        end if;
        if not fits_working_hours(v_agenda_id, p_new_starts_at, v_ends_at) then
            raise exception 'fora_do_horario_de_atendimento';
        end if;
        if slot_is_taken(v_agenda_id, p_new_starts_at, v_ends_at, p_appointment_id) then
            raise exception 'horario_indisponivel';
        end if;
    end if;

    update appointments
    set agenda_id = v_agenda_id,
        appointment_type_id = v_type_id,
        starts_at = p_new_starts_at,
        ends_at = v_ends_at,
        status = 'agendado'
    where id = p_appointment_id
    returning * into v_appointment;

    return v_appointment;
end;
$$;

-- ---------------------------------------------------------------------
-- supabase/migrations/20261027000004_reminders.sql
-- ---------------------------------------------------------------------

-- Return reminders per procedure, and birthday messages.
--
-- A patient's pending reminder for a procedure is *derived* from their latest
-- attended ('chegou') appointment that included that procedure, counting only
-- visits registered in this system: history imported from FastClinic never
-- produces reminders, unless staff marks its status here after the import
-- (e.g. a visit booked in FastClinic that happens after go-live):
--   due_on = visit date + procedure.reminder_months (or the default).
-- Doing the same procedure again moves the countdown; other procedures'
-- reminders are untouched. Any change that could affect this (status,
-- date, procedures of an appointment, procedure period) queues the patient,
-- and the queue is processed once per patient at commit time, so corrections
-- (un-marking 'chegou', removing a procedure) fix the reminder instead of
-- leaving stale ones behind.

create type reminder_status as enum ('pendente', 'enviado', 'cancelado', 'erro', 'expirado');

create table reminders (
    id uuid primary key default gen_random_uuid(),
    patient_id uuid not null references patients (id) on delete cascade,
    procedure_id uuid not null references procedures (id) on delete cascade,
    source_appointment_id uuid references appointments (id) on delete set null,
    -- added by hand in the reminders screen rather than derived from a visit
    created_manually boolean not null default false,
    last_done_at timestamptz,
    due_on date not null,
    status reminder_status not null default 'pendente',
    -- due date was changed by hand; keep it until the patient comes back
    manual_due boolean not null default false,
    closed_reason text check (closed_reason in ('manual', 'origem_desfeita', 'vencido')),
    attempts integer not null default 0,
    next_attempt_at timestamptz,
    locked_until timestamptz,
    last_error text,
    sent_at timestamptz,
    notes text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create unique index reminders_one_pending_idx on reminders (patient_id, procedure_id) where status = 'pendente';
create index reminders_due_idx on reminders (due_on) where status = 'pendente';
create index reminders_source_idx on reminders (source_appointment_id);

create trigger reminders_set_updated_at before update on reminders
for each row execute function set_updated_at();

create function reminder_months_for(p_procedure_id uuid) returns integer
language sql stable as $$
    select coalesce(reminder_months, setting_int('default_reminder_months', 6))
    from procedures where id = p_procedure_id
$$;

create function recompute_reminder(p_patient_id uuid, p_procedure_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
    v_last_id uuid;
    v_last_at timestamptz;
    v_due date;
    v_pending reminders;
begin
    select a.id, a.starts_at into v_last_id, v_last_at
    from appointments a
    join appointment_procedures ap on ap.appointment_id = a.id
    where a.patient_id = p_patient_id
      and ap.procedure_id = p_procedure_id
      and a.status = 'chegou'
      and (a.source <> 'legado' or a.status_changed_at > a.legacy_synced_at)
    order by a.starts_at desc
    limit 1;

    select * into v_pending from reminders
    where patient_id = p_patient_id and procedure_id = p_procedure_id and status = 'pendente'
    for update;

    if v_last_id is null then
        -- The visit that generated the reminder no longer counts.
        if v_pending.id is not null and not v_pending.created_manually then
            update reminders set status = 'cancelado', closed_reason = 'origem_desfeita', locked_until = null
            where id = v_pending.id;
        end if;
        return;
    end if;

    -- This visit's reminder was already sent, expired or deliberately cancelled.
    if exists (
        select 1 from reminders
        where patient_id = p_patient_id and procedure_id = p_procedure_id
          and source_appointment_id = v_last_id
          and (status in ('enviado', 'expirado', 'erro') or (status = 'cancelado' and closed_reason = 'manual'))
    ) then
        if v_pending.id is not null and v_pending.source_appointment_id is distinct from v_last_id
           and not v_pending.created_manually then
            update reminders set status = 'cancelado', closed_reason = 'origem_desfeita', locked_until = null
            where id = v_pending.id;
        end if;
        return;
    end if;

    v_due := ((v_last_at at time zone clinic_tz())::date + make_interval(months => reminder_months_for(p_procedure_id)))::date;

    if v_pending.id is null then
        insert into reminders (patient_id, procedure_id, source_appointment_id, last_done_at, due_on)
        values (p_patient_id, p_procedure_id, v_last_id, v_last_at, v_due);
    elsif v_pending.source_appointment_id is distinct from v_last_id then
        -- A newer visit with the same procedure: restart the countdown.
        update reminders
        set source_appointment_id = v_last_id, last_done_at = v_last_at, due_on = v_due,
            manual_due = false, created_manually = false, attempts = 0, next_attempt_at = null, locked_until = null, last_error = null
        where id = v_pending.id;
    elsif not v_pending.manual_due and (v_pending.due_on <> v_due or v_pending.last_done_at <> v_last_at) then
        update reminders set due_on = v_due, last_done_at = v_last_at where id = v_pending.id;
    end if;
end;
$$;

create function recompute_patient_reminders(p_patient_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
    v_procedure_id uuid;
begin
    for v_procedure_id in
        select procedure_id from reminders where patient_id = p_patient_id and status = 'pendente'
        union
        select ap.procedure_id
        from appointments a join appointment_procedures ap on ap.appointment_id = a.id
        where a.patient_id = p_patient_id and a.status = 'chegou'
          and (a.source <> 'legado' or a.status_changed_at > a.legacy_synced_at)
    loop
        perform recompute_reminder(p_patient_id, v_procedure_id);
    end loop;
end;
$$;

-- Patients whose reminders must be recomputed when the current transaction commits.
create table reminder_recalc_queue (
    patient_id uuid primary key
);

create function enqueue_reminder_recalc(p_patient_id uuid) returns void
language sql security definer set search_path = public as $$
    insert into reminder_recalc_queue (patient_id) values (p_patient_id) on conflict do nothing
$$;

create function process_reminder_recalc() returns trigger
language plpgsql security definer set search_path = public as $$
begin
    perform recompute_patient_reminders(new.patient_id);
    delete from reminder_recalc_queue where patient_id = new.patient_id;
    return null;
end;
$$;

create constraint trigger reminder_recalc_at_commit
after insert on reminder_recalc_queue
deferrable initially deferred
for each row execute function process_reminder_recalc();

create function appointments_queue_reminders() returns trigger
language plpgsql security definer set search_path = public as $$
begin
    if tg_op in ('UPDATE', 'DELETE') and old.status = 'chegou' then
        perform enqueue_reminder_recalc(old.patient_id);
    end if;
    if tg_op in ('INSERT', 'UPDATE') and new.status = 'chegou' then
        perform enqueue_reminder_recalc(new.patient_id);
    end if;
    return null;
end;
$$;

create trigger appointments_queue_reminders
after insert or update of status, starts_at, patient_id or delete on appointments
for each row execute function appointments_queue_reminders();

create function appointment_procedures_queue_reminders() returns trigger
language plpgsql security definer set search_path = public as $$
declare
    v_patient_id uuid;
begin
    select patient_id into v_patient_id
    from appointments
    where id = coalesce(new.appointment_id, old.appointment_id) and status = 'chegou';
    if v_patient_id is not null then
        perform enqueue_reminder_recalc(v_patient_id);
    end if;
    return null;
end;
$$;

create trigger appointment_procedures_queue_reminders
after insert or delete on appointment_procedures
for each row execute function appointment_procedures_queue_reminders();

create function procedures_queue_reminders() returns trigger
language plpgsql security definer set search_path = public as $$
begin
    perform enqueue_reminder_recalc(r.patient_id)
    from reminders r
    where r.procedure_id = new.id and r.status = 'pendente';
    return null;
end;
$$;

create trigger procedures_queue_reminders
after update of reminder_months on procedures
for each row when (old.reminder_months is distinct from new.reminder_months)
execute function procedures_queue_reminders();

create function settings_queue_reminders() returns trigger
language plpgsql security definer set search_path = public as $$
begin
    if new.key = 'default_reminder_months' and new.value is distinct from old.value then
        perform enqueue_reminder_recalc(r.patient_id)
        from reminders r join procedures p on p.id = r.procedure_id
        where r.status = 'pendente' and p.reminder_months is null;
    end if;
    return null;
end;
$$;

create trigger settings_queue_reminders after update on settings
for each row execute function settings_queue_reminders();

-- ---------------------------------------------------------------------------
-- Dispatch queue (called by the daily cron with the service role).
-- Claimed rows get a lease so two overlapping runs never send twice; failures
-- back off exponentially and give up after 5 attempts.
-- ---------------------------------------------------------------------------

create function claim_due_reminders(p_limit integer default 50, p_lease_minutes integer default 10)
returns table (
    reminder_id uuid,
    patient_id uuid,
    patient_name text,
    phone text,
    phone_digits text,
    procedure_id uuid,
    procedure_name text,
    last_done_at timestamptz,
    due_on date,
    attempts integer
)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
    v_today date := clinic_today();
begin
    -- Too late to be a timely reminder (e.g. old history imported at go-live,
    -- or the cron was down). Kept for recovery campaigns, never auto-sent.
    update reminders
    set status = 'expirado', closed_reason = 'vencido', locked_until = null
    where status = 'pendente'
      and due_on < v_today - setting_int('reminder_max_overdue_days', 30);

    return query
    with due as (
        select r.id
        from reminders r
        join patients p on p.id = r.patient_id
        where r.status = 'pendente'
          and r.due_on <= v_today
          and (r.next_attempt_at is null or r.next_attempt_at <= now())
          and (r.locked_until is null or r.locked_until < now())
          and p.allow_messages
          and p.phone_digits <> ''
          -- already coming back: wait and see if they redo the procedure
          and not exists (
              select 1 from appointments a
              where a.patient_id = r.patient_id
                and a.starts_at > now()
                and a.status in ('agendado', 'confirmado')
          )
        order by r.due_on
        limit p_limit
        for update of r skip locked
    ),
    claimed as (
        update reminders r
        set locked_until = now() + make_interval(mins => p_lease_minutes), attempts = r.attempts + 1
        from due
        where r.id = due.id
        returning r.*
    )
    select c.id, c.patient_id, p.full_name, p.phone, p.phone_digits, c.procedure_id, pr.name,
           c.last_done_at, c.due_on, c.attempts
    from claimed c
    join patients p on p.id = c.patient_id
    join procedures pr on pr.id = c.procedure_id;
end;
$$;

create function mark_reminder_sent(p_reminder_id uuid) returns void
language sql security definer set search_path = public as $$
    update reminders
    set status = 'enviado', sent_at = now(), locked_until = null, last_error = null
    where id = p_reminder_id and status = 'pendente'
$$;

create function mark_reminder_failed(p_reminder_id uuid, p_error text) returns void
language sql security definer set search_path = public as $$
    update reminders
    set last_error = left(p_error, 1000),
        locked_until = null,
        status = case when attempts >= 5 then 'erro'::reminder_status else status end,
        next_attempt_at = now() + least(interval '24 hours', interval '1 hour' * power(2, attempts - 1))
    where id = p_reminder_id and status = 'pendente'
$$;

-- ---------------------------------------------------------------------------
-- Birthdays
-- ---------------------------------------------------------------------------

create table birthday_messages (
    id uuid primary key default gen_random_uuid(),
    patient_id uuid not null references patients (id) on delete cascade,
    year integer not null,
    status text not null default 'pendente' check (status in ('pendente', 'enviado', 'erro')),
    attempts integer not null default 0,
    locked_until timestamptz,
    last_error text,
    sent_at timestamptz,
    created_at timestamptz not null default now(),
    unique (patient_id, year)
);

-- 29/02 birthdays are celebrated on 28/02 in non-leap years.
create function is_birthday(p_birth_date date, p_day date) returns boolean
language sql immutable parallel safe as $$
    select extract(month from p_birth_date) = extract(month from p_day)
       and (
           extract(day from p_birth_date) = extract(day from p_day)
           or (
               extract(month from p_birth_date) = 2 and extract(day from p_birth_date) = 29
               and extract(day from p_day) = 28
               and (p_day + 1) = make_date(extract(year from p_day)::integer, 3, 1)
           )
       )
$$;

create function claim_birthdays(p_limit integer default 200, p_lease_minutes integer default 10)
returns table (
    message_id uuid,
    patient_id uuid,
    patient_name text,
    phone text,
    phone_digits text,
    birth_date date,
    age integer,
    attempts integer
)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
    v_today date := clinic_today();
    v_year integer := extract(year from clinic_today())::integer;
begin
    insert into birthday_messages (patient_id, year)
    select p.id, v_year
    from patients p
    where p.birth_date is not null
      and p.allow_messages
      and p.phone_digits <> ''
      and extract(month from p.birth_date) = extract(month from v_today)
      and is_birthday(p.birth_date, v_today)
    on conflict do nothing;

    return query
    with due as (
        select b.id
        from birthday_messages b
        join patients p on p.id = b.patient_id
        where b.year = v_year
          and b.status = 'pendente'
          and b.attempts < 5
          and (b.locked_until is null or b.locked_until < now())
          and is_birthday(p.birth_date, v_today)
        limit p_limit
        for update of b skip locked
    ),
    claimed as (
        update birthday_messages b
        set locked_until = now() + make_interval(mins => p_lease_minutes), attempts = b.attempts + 1
        from due
        where b.id = due.id
        returning b.*
    )
    select c.id, c.patient_id, p.full_name, p.phone, p.phone_digits, p.birth_date,
           extract(year from age(v_today, p.birth_date))::integer, c.attempts
    from claimed c
    join patients p on p.id = c.patient_id;
end;
$$;

create function mark_birthday_sent(p_message_id uuid) returns void
language sql security definer set search_path = public as $$
    update birthday_messages set status = 'enviado', sent_at = now(), locked_until = null, last_error = null
    where id = p_message_id
$$;

create function mark_birthday_failed(p_message_id uuid, p_error text) returns void
language sql security definer set search_path = public as $$
    update birthday_messages
    set last_error = left(p_error, 1000),
        locked_until = null,
        status = case when attempts >= 5 then 'erro' else status end
    where id = p_message_id
$$;

-- Patients whose birthday is on a given day (for the Lembretes screen).
create function birthdays_on(p_day date default clinic_today()) returns setof patients
language sql stable as $$
    select * from patients
    where birth_date is not null
      and extract(month from birth_date) = extract(month from p_day)
      and is_birthday(birth_date, p_day)
    order by full_name
$$;

-- ---------------------------------------------------------------------
-- supabase/migrations/20261027000005_finance_stock.sql
-- ---------------------------------------------------------------------

-- Payments recorded per patient/visit, and a simple stock control.

create type payment_method as enum ('pix', 'dinheiro', 'cartao_credito', 'cartao_debito', 'transferencia', 'boleto', 'outro');
create type payment_status as enum ('pago', 'pendente');

create table payments (
    id uuid primary key default gen_random_uuid(),
    patient_id uuid not null references patients (id) on delete restrict,
    appointment_id uuid references appointments (id) on delete set null,
    amount numeric(12, 2) not null check (amount > 0),
    method payment_method,
    installments integer not null default 1 check (installments between 1 and 24),
    status payment_status not null default 'pago',
    occurred_on date not null default clinic_today(),
    description text,
    created_by uuid references staff (id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check (status = 'pendente' or method is not null)
);

create index payments_patient_idx on payments (patient_id, occurred_on desc);
create index payments_occurred_on_idx on payments (occurred_on);

create trigger payments_set_updated_at before update on payments
for each row execute function set_updated_at();

-- Daily/monthly report for the Financeiro screen (Dr. Everson only).
create function finance_summary(p_from date, p_to date) returns jsonb
language plpgsql stable as $$
declare
    v_result jsonb;
begin
    if not is_admin() and current_user not in ('postgres', 'service_role') then
        raise exception 'acesso_negado';
    end if;

    with p as (
        select * from payments where occurred_on between p_from and p_to
    )
    select jsonb_build_object(
        'total_pago', coalesce((select sum(amount) from p where status = 'pago'), 0),
        'total_pendente', coalesce((select sum(amount) from p where status = 'pendente'), 0),
        'quantidade', (select count(*) from p),
        'por_forma', coalesce((
            select jsonb_agg(jsonb_build_object('forma', method, 'total', total, 'quantidade', n) order by total desc)
            from (select method, sum(amount) as total, count(*) as n from p where status = 'pago' group by method) m
        ), '[]'::jsonb),
        'por_dia', coalesce((
            select jsonb_agg(jsonb_build_object('dia', occurred_on, 'pago', pago, 'pendente', pendente) order by occurred_on)
            from (
                select occurred_on,
                       sum(amount) filter (where status = 'pago') as pago,
                       sum(amount) filter (where status = 'pendente') as pendente
                from p group by occurred_on
            ) d
        ), '[]'::jsonb)
    ) into v_result;

    return v_result;
end;
$$;

create type stock_movement_type as enum ('entrada', 'saida');

create table stock_products (
    id uuid primary key default gen_random_uuid(),
    name text not null check (btrim(name) <> ''),
    unit text not null default 'un',
    location text,
    min_quantity numeric(12, 2) not null default 0,
    notes text,
    active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create unique index stock_products_name_idx on stock_products (normalize_text(btrim(name)));

create trigger stock_products_set_updated_at before update on stock_products
for each row execute function set_updated_at();

create table stock_movements (
    id uuid primary key default gen_random_uuid(),
    product_id uuid not null references stock_products (id) on delete cascade,
    type stock_movement_type not null,
    quantity numeric(12, 2) not null check (quantity > 0),
    moved_at timestamptz not null default now(),
    note text,
    created_by uuid references staff (id) on delete set null,
    created_at timestamptz not null default now()
);

create index stock_movements_product_idx on stock_movements (product_id, moved_at desc);

create view stock_levels with (security_invoker = true) as
select p.id, p.name, p.unit, p.location, p.min_quantity, p.notes, p.active,
       coalesce(sum(case when m.type = 'entrada' then m.quantity else -m.quantity end), 0) as quantity,
       max(m.moved_at) as last_movement_at
from stock_products p
left join stock_movements m on m.product_id = p.id
group by p.id;

-- ---------------------------------------------------------------------
-- supabase/migrations/20261027000006_messaging.sql
-- ---------------------------------------------------------------------

-- Internal team chat ("grupos" per agenda/sector) and the read-only mirror of
-- patients' WhatsApp conversations received from the Evolution API.

create table chat_channels (
    id uuid primary key default gen_random_uuid(),
    name text not null unique,
    agenda_id uuid unique references agendas (id) on delete set null,
    created_at timestamptz not null default now()
);

-- Extra members beyond the defaults (admin and secretaries see every channel;
-- a professional sees the channel of their own agenda).
create table chat_channel_members (
    channel_id uuid not null references chat_channels (id) on delete cascade,
    staff_id uuid not null references staff (id) on delete cascade,
    primary key (channel_id, staff_id)
);

create table chat_messages (
    id uuid primary key default gen_random_uuid(),
    channel_id uuid not null references chat_channels (id) on delete cascade,
    author_id uuid references staff (id) on delete set null,
    body text not null check (btrim(body) <> ''),
    created_at timestamptz not null default now()
);

create index chat_messages_channel_idx on chat_messages (channel_id, created_at desc);

create table chat_reads (
    channel_id uuid not null references chat_channels (id) on delete cascade,
    staff_id uuid not null references staff (id) on delete cascade,
    last_read_at timestamptz not null default now(),
    primary key (channel_id, staff_id)
);

create function can_access_channel(p_channel_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
    select exists (
        select 1
        from staff s
        join chat_channels c on c.id = p_channel_id
        where s.id = auth.uid() and s.active
          and (
              s.role in ('admin', 'secretaria')
              or (c.agenda_id is not null and c.agenda_id = s.agenda_id)
              or exists (select 1 from chat_channel_members m where m.channel_id = c.id and m.staff_id = s.id)
          )
    )
$$;

create function agendas_create_channel() returns trigger
language plpgsql security definer set search_path = public as $$
begin
    insert into chat_channels (name, agenda_id) values (new.name, new.id)
    on conflict (name) do update set agenda_id = excluded.agenda_id;
    return null;
end;
$$;

create trigger agendas_create_channel after insert on agendas
for each row when (new.active) execute function agendas_create_channel();

create function unread_counts() returns table (channel_id uuid, unread bigint)
language sql stable as $$
    select c.id,
           (select count(*) from chat_messages m
            where m.channel_id = c.id
              and m.author_id is distinct from auth.uid()
              and m.created_at > coalesce(
                  (select r.last_read_at from chat_reads r where r.channel_id = c.id and r.staff_id = auth.uid()),
                  '-infinity'::timestamptz))
    from chat_channels c
    where can_access_channel(c.id)
$$;

create table whatsapp_messages (
    id uuid primary key default gen_random_uuid(),
    instance text not null,
    wa_message_id text not null,
    remote_jid text not null,
    phone_digits text,
    patient_id uuid references patients (id) on delete set null,
    from_me boolean not null default false,
    push_name text,
    message_type text,
    body text,
    sent_at timestamptz not null,
    raw jsonb,
    -- staff member who sent it from the system (null: sent from the phone)
    sent_by uuid references staff (id) on delete set null,
    -- delivery of our own messages: pendente → enviado → entregue → lido (or erro)
    status text check (status in ('pendente', 'enviado', 'entregue', 'lido', 'erro')),
    -- photos, videos, audio, documents and stickers are copied into Storage
    -- (bucket "prontuario", folder whatsapp/), since WhatsApp's links expire
    media_kind text check (media_kind in ('imagem', 'video', 'audio', 'documento', 'figurinha')),
    media_status text check (media_status in ('pendente', 'ok', 'erro')),
    media_path text,
    media_mime text,
    media_name text,
    media_size bigint,
    media_error text,
    created_at timestamptz not null default now(),
    unique (instance, wa_message_id)
);

create index whatsapp_messages_jid_idx on whatsapp_messages (remote_jid, sent_at desc);
create index whatsapp_messages_patient_idx on whatsapp_messages (patient_id);

-- Only moves forward: a late "delivered" never undoes "read".
create function whatsapp_status_rank(p_status text) returns integer
language sql immutable parallel safe as $$
    select case p_status
        when 'erro' then 0 when 'pendente' then 1 when 'enviado' then 2
        when 'entregue' then 3 when 'lido' then 4 else -1 end
$$;

-- The WhatsApp inbox is shared: once someone on the team opens a
-- conversation, it is read for everybody.
create table whatsapp_reads (
    remote_jid text primary key,
    read_at timestamptz not null default now(),
    read_by uuid references staff (id) on delete set null
);

create function mark_whatsapp_read(p_remote_jid text) returns void
language sql as $$
    insert into whatsapp_reads (remote_jid, read_at, read_by)
    values (p_remote_jid, now(), auth.uid())
    on conflict (remote_jid) do update set read_at = excluded.read_at, read_by = excluded.read_by
$$;

create function match_patient_by_phone(p_digits text) returns uuid
language sql stable as $$
    select id from patients
    where phone_key(p_digits) is not null
      and (phone_key(phone) = phone_key(p_digits) or phone_key(phone_alt) = phone_key(p_digits))
    order by updated_at desc
    limit 1
$$;

-- The patient link is resolved at read time too, so a conversation that
-- started before the patient was registered still shows their name.
create view whatsapp_conversations with (security_invoker = true) as
select c.*, p.full_name as patient_name
from (
    select distinct on (m.remote_jid)
        m.remote_jid,
        m.phone_digits,
        coalesce(m.patient_id, match_patient_by_phone(m.phone_digits)) as patient_id,
        -- our own messages carry no contact name; use the latest one they sent
        coalesce(m.push_name, (select x.push_name from whatsapp_messages x
                               where x.remote_jid = m.remote_jid and x.push_name is not null
                               order by x.sent_at desc limit 1)) as push_name,
        m.body as last_body,
        m.media_kind as last_media_kind,
        m.from_me as last_from_me,
        m.status as last_status,
        m.sent_at as last_at,
        (select count(*) from whatsapp_messages x where x.remote_jid = m.remote_jid) as message_count,
        (select count(*) from whatsapp_messages x
         where x.remote_jid = m.remote_jid and not x.from_me
           and x.sent_at > coalesce((select r.read_at from whatsapp_reads r where r.remote_jid = m.remote_jid), '-infinity'::timestamptz)
        ) as unread_count
    from whatsapp_messages m
    order by m.remote_jid, m.sent_at desc
) c
left join patients p on p.id = c.patient_id;

-- ---------------------------------------------------------------------
-- supabase/migrations/20261027000007_security.sql
-- ---------------------------------------------------------------------

-- Row level security, authorship defaults, realtime and storage.
-- Policies wrap is_staff()/is_admin()/auth.uid() in (select ...) so Postgres
-- evaluates them once per query instead of once per row (Supabase's
-- recommended RLS pattern; it matters on the 150k record entries).
-- Everyone on the clinic staff works with patients, agenda, records, payments
-- and stock; configuration and deletions of sensitive data are admin-only.
-- The HTTP API and the cron use the service role, which bypasses RLS.

create function set_created_by() returns trigger
language plpgsql as $$
begin
    new.created_by = coalesce(new.created_by, auth.uid());
    return new;
end;
$$;

create function set_author_id() returns trigger
language plpgsql as $$
begin
    new.author_id = coalesce(new.author_id, auth.uid());
    return new;
end;
$$;

create trigger patients_set_created_by before insert on patients for each row execute function set_created_by();
create trigger appointments_set_created_by before insert on appointments for each row execute function set_created_by();
create trigger agenda_blocks_set_created_by before insert on agenda_blocks for each row execute function set_created_by();
create trigger record_attachments_set_created_by before insert on record_attachments for each row execute function set_created_by();
create trigger payments_set_created_by before insert on payments for each row execute function set_created_by();
create trigger stock_movements_set_created_by before insert on stock_movements for each row execute function set_created_by();
create trigger record_entries_set_author before insert on record_entries for each row execute function set_author_id();
create trigger chat_messages_set_author before insert on chat_messages for each row execute function set_author_id();

-- Staff can read everything; admin manages people.
alter table staff enable row level security;
create policy staff_select on staff for select to authenticated using ((select is_staff()));
create policy staff_admin on staff for all to authenticated using ((select is_admin())) with check ((select is_admin()));

alter table settings enable row level security;
create policy settings_select on settings for select to authenticated using ((select is_staff()));
create policy settings_admin on settings for all to authenticated using ((select is_admin())) with check ((select is_admin()));

-- Clinical day-to-day data: any staff member.
alter table patients enable row level security;
create policy patients_select on patients for select to authenticated using ((select is_staff()));
create policy patients_insert on patients for insert to authenticated with check ((select is_staff()));
create policy patients_update on patients for update to authenticated using ((select is_staff())) with check ((select is_staff()));
create policy patients_delete on patients for delete to authenticated using ((select is_admin()));

alter table record_entries enable row level security;
create policy record_entries_select on record_entries for select to authenticated using ((select is_staff()));
create policy record_entries_insert on record_entries for insert to authenticated with check ((select is_staff()));
create policy record_entries_update on record_entries for update to authenticated
    using ((select is_admin()) or author_id = (select auth.uid())) with check ((select is_admin()) or author_id = (select auth.uid()));
create policy record_entries_delete on record_entries for delete to authenticated
    using ((select is_admin()) or author_id = (select auth.uid()));

alter table record_attachments enable row level security;
create policy record_attachments_select on record_attachments for select to authenticated using ((select is_staff()));
create policy record_attachments_insert on record_attachments for insert to authenticated with check ((select is_staff()));
create policy record_attachments_delete on record_attachments for delete to authenticated
    using ((select is_admin()) or created_by = (select auth.uid()));

alter table appointments enable row level security;
create policy appointments_select on appointments for select to authenticated using ((select is_staff()));
create policy appointments_insert on appointments for insert to authenticated with check ((select is_staff()));
create policy appointments_update on appointments for update to authenticated using ((select is_staff())) with check ((select is_staff()));
create policy appointments_delete on appointments for delete to authenticated using ((select is_admin()));

alter table appointment_procedures enable row level security;
create policy appointment_procedures_all on appointment_procedures for all to authenticated
    using ((select is_staff())) with check ((select is_staff()));

alter table agenda_blocks enable row level security;
create policy agenda_blocks_all on agenda_blocks for all to authenticated using ((select is_staff())) with check ((select is_staff()));

alter table procedures enable row level security;
create policy procedures_select on procedures for select to authenticated using ((select is_staff()));
create policy procedures_insert on procedures for insert to authenticated with check ((select is_staff()));
create policy procedures_admin on procedures for update to authenticated using ((select is_admin())) with check ((select is_admin()));
create policy procedures_delete on procedures for delete to authenticated using ((select is_admin()));

alter table reminders enable row level security;
create policy reminders_select on reminders for select to authenticated using ((select is_staff()));
create policy reminders_insert on reminders for insert to authenticated with check ((select is_staff()));
create policy reminders_update on reminders for update to authenticated using ((select is_staff())) with check ((select is_staff()));
create policy reminders_delete on reminders for delete to authenticated using ((select is_admin()));

alter table reminder_recalc_queue enable row level security;

alter table birthday_messages enable row level security;
create policy birthday_messages_select on birthday_messages for select to authenticated using ((select is_staff()));

alter table payments enable row level security;
create policy payments_select on payments for select to authenticated using ((select is_staff()));
create policy payments_insert on payments for insert to authenticated with check ((select is_staff()));
create policy payments_update on payments for update to authenticated using ((select is_staff())) with check ((select is_staff()));
create policy payments_delete on payments for delete to authenticated using ((select is_admin()));

alter table stock_products enable row level security;
create policy stock_products_all on stock_products for all to authenticated using ((select is_staff())) with check ((select is_staff()));

alter table stock_movements enable row level security;
create policy stock_movements_all on stock_movements for all to authenticated using ((select is_staff())) with check ((select is_staff()));

-- Configuration: read for staff, change for admin.
alter table agendas enable row level security;
create policy agendas_select on agendas for select to authenticated using ((select is_staff()));
create policy agendas_admin on agendas for all to authenticated using ((select is_admin())) with check ((select is_admin()));

alter table agenda_hours enable row level security;
create policy agenda_hours_select on agenda_hours for select to authenticated using ((select is_staff()));
create policy agenda_hours_admin on agenda_hours for all to authenticated using ((select is_admin())) with check ((select is_admin()));

alter table agenda_slot_times enable row level security;
create policy agenda_slot_times_select on agenda_slot_times for select to authenticated using ((select is_staff()));
create policy agenda_slot_times_admin on agenda_slot_times for all to authenticated using ((select is_admin())) with check ((select is_admin()));

alter table appointment_types enable row level security;
create policy appointment_types_select on appointment_types for select to authenticated using ((select is_staff()));
create policy appointment_types_admin on appointment_types for all to authenticated using ((select is_admin())) with check ((select is_admin()));

alter table note_shortcuts enable row level security;
create policy note_shortcuts_select on note_shortcuts for select to authenticated using ((select is_staff()));
create policy note_shortcuts_admin on note_shortcuts for all to authenticated using ((select is_admin())) with check ((select is_admin()));

-- Internal chat.
alter table chat_channels enable row level security;
create policy chat_channels_select on chat_channels for select to authenticated using (can_access_channel(id));
create policy chat_channels_admin on chat_channels for all to authenticated using ((select is_admin())) with check ((select is_admin()));

alter table chat_channel_members enable row level security;
create policy chat_channel_members_select on chat_channel_members for select to authenticated using ((select is_staff()));
create policy chat_channel_members_admin on chat_channel_members for all to authenticated using ((select is_admin())) with check ((select is_admin()));

alter table chat_messages enable row level security;
create policy chat_messages_select on chat_messages for select to authenticated using (can_access_channel(channel_id));
create policy chat_messages_insert on chat_messages for insert to authenticated
    with check (can_access_channel(channel_id) and author_id = (select auth.uid()));
create policy chat_messages_delete on chat_messages for delete to authenticated using (author_id = (select auth.uid()));

alter table chat_reads enable row level security;
create policy chat_reads_own on chat_reads for all to authenticated
    using (staff_id = (select auth.uid())) with check (staff_id = (select auth.uid()));

-- WhatsApp mirror: written only by the webhook (service role).
alter table whatsapp_messages enable row level security;
create policy whatsapp_messages_select on whatsapp_messages for select to authenticated using ((select is_staff()));

alter table whatsapp_reads enable row level security;
create policy whatsapp_reads_all on whatsapp_reads for all to authenticated
    using ((select is_staff())) with check ((select is_staff()));

-- Queue/dispatch internals are for the server only.
revoke execute on function
    claim_due_reminders(integer, integer),
    mark_reminder_sent(uuid),
    mark_reminder_failed(uuid, text),
    claim_birthdays(integer, integer),
    mark_birthday_sent(uuid),
    mark_birthday_failed(uuid, text),
    recompute_reminder(uuid, uuid),
    recompute_patient_reminders(uuid),
    enqueue_reminder_recalc(uuid)
from public;

do $$
begin
    if exists (select 1 from pg_roles where rolname = 'anon') then
        revoke execute on function
            claim_due_reminders(integer, integer), mark_reminder_sent(uuid), mark_reminder_failed(uuid, text),
            claim_birthdays(integer, integer), mark_birthday_sent(uuid), mark_birthday_failed(uuid, text),
            recompute_reminder(uuid, uuid), recompute_patient_reminders(uuid), enqueue_reminder_recalc(uuid)
        from anon, authenticated;
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
        grant execute on function
            claim_due_reminders(integer, integer), mark_reminder_sent(uuid), mark_reminder_failed(uuid, text),
            claim_birthdays(integer, integer), mark_birthday_sent(uuid), mark_birthday_failed(uuid, text),
            recompute_reminder(uuid, uuid), recompute_patient_reminders(uuid)
        to service_role;
    end if;
end;
$$;

-- Live updates for the agenda, the internal chat and the WhatsApp mirror.
do $$
begin
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
        alter publication supabase_realtime add table appointments, chat_messages, whatsapp_messages, whatsapp_reads;
    end if;
end;
$$;

-- Private bucket for record attachments.
do $$
begin
    if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
        insert into storage.buckets (id, name, public) values ('prontuario', 'prontuario', false)
        on conflict (id) do nothing;

        execute 'drop policy if exists prontuario_staff_read on storage.objects';
        execute $p$
            create policy prontuario_staff_read on storage.objects for select to authenticated
            using (bucket_id = 'prontuario' and (select public.is_staff()))
        $p$;
        execute 'drop policy if exists prontuario_staff_write on storage.objects';
        execute $p$
            create policy prontuario_staff_write on storage.objects for insert to authenticated
            with check (bucket_id = 'prontuario' and (select public.is_staff()))
        $p$;
        execute 'drop policy if exists prontuario_staff_delete on storage.objects';
        execute $p$
            create policy prontuario_staff_delete on storage.objects for delete to authenticated
            using (bucket_id = 'prontuario' and (select public.is_staff()))
        $p$;
    end if;
end;
$$;

-- ---------------------------------------------------------------------
-- supabase/migrations/20261027000008_superadmin.sql
-- ---------------------------------------------------------------------

-- Super admin: the agency that set the system up. Everything an admin can do,
-- plus the integrations (reminder/birthday webhooks, the WhatsApp
-- connection). Admins (the clinic) can neither see nor change those, nor edit
-- a super admin's login.

alter table staff add column is_superadmin boolean not null default false;
alter table staff add constraint staff_superadmin_is_admin check (not is_superadmin or role = 'admin');

create function is_superadmin() returns boolean
language sql stable security definer set search_path = public as $$
    select coalesce((select s.is_superadmin from staff s where s.id = auth.uid() and s.active and s.role = 'admin'), false)
$$;

-- Settings only the super admin sees and edits.
alter table settings add column superadmin_only boolean not null default false;
update settings set superadmin_only = true where key in ('reminder_webhook_url', 'birthday_webhook_url');

drop policy settings_select on settings;
drop policy settings_admin on settings;
create policy settings_select on settings for select to authenticated
    using ((select is_staff()) and (not superadmin_only or (select is_superadmin())));
create policy settings_admin on settings for all to authenticated
    using ((select is_admin()) and (not superadmin_only or (select is_superadmin())))
    with check ((select is_admin()) and (not superadmin_only or (select is_superadmin())));

-- Admins manage the team, except super admins.
drop policy staff_admin on staff;
create policy staff_admin on staff for all to authenticated
    using ((select is_admin()) and (not is_superadmin or (select is_superadmin())))
    with check ((select is_admin()) and (not is_superadmin or (select is_superadmin())));

-- ---------------------------------------------------------------------
-- supabase/migrations/20261027000009_hide_superadmin.sql
-- ---------------------------------------------------------------------

-- The support login is invisible to the clinic: only another super admin
-- sees it (in Ajustes → Usuários, chat author names, etc.).

drop policy staff_select on staff;
create policy staff_select on staff for select to authenticated
    using ((select is_staff()) and (not is_superadmin or (select is_superadmin()) or id = (select auth.uid())));

-- ---------------------------------------------------------------------
-- supabase/migrations/20261027000010_legacy_payments.sql
-- ---------------------------------------------------------------------

-- Charges recorded in FastClinic (its PRODUTOS_ESTOQUE table: what each
-- visit was billed) come in as payments, keyed for re-imports.

alter table payments add column legacy_id integer unique;
alter table payments add column legacy_synced_at timestamptz;

-- ---------------------------------------------------------------------
-- supabase/migrations/20261027000011_manage_groups_archive.sql
-- ---------------------------------------------------------------------

-- Team groups the admin creates (for everyone, or for chosen people), and
-- "delete" for procedures and agendas that keeps history intact: one never
-- used is deleted; one with visits behind it is archived (hidden, kept).

alter table chat_channels add column everyone boolean not null default false;
update chat_channels set everyone = true where name = 'Recepção';

create or replace function can_access_channel(p_channel_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
    select exists (
        select 1
        from staff s
        join chat_channels c on c.id = p_channel_id
        where s.id = auth.uid() and s.active
          and (
              s.role in ('admin', 'secretaria')
              or c.everyone
              or (c.agenda_id is not null and c.agenda_id = s.agenda_id)
              or exists (select 1 from chat_channel_members m where m.channel_id = c.id and m.staff_id = s.id)
          )
    )
$$;

alter table procedures add column archived boolean not null default false;

-- Runs as the caller, so the admin-only policies decide who may do it.
create function delete_procedure(p_id uuid) returns text
language plpgsql as $$
begin
    if exists (select 1 from appointment_procedures where procedure_id = p_id) then
        update procedures set active = false, archived = true where id = p_id;
        if not found then raise exception 'acesso_negado'; end if;
        delete from reminders where procedure_id = p_id and status = 'pendente';
        return 'arquivado';
    end if;
    delete from procedures where id = p_id;
    if not found then raise exception 'acesso_negado'; end if;
    return 'apagado';
end;
$$;

create function delete_agenda(p_id uuid) returns text
language plpgsql as $$
begin
    if exists (select 1 from appointments where agenda_id = p_id) then
        update agendas set active = false where id = p_id;
        if not found then raise exception 'acesso_negado'; end if;
        return 'arquivado';
    end if;
    delete from agendas where id = p_id;
    if not found then raise exception 'acesso_negado'; end if;
    return 'apagado';
end;
$$;

-- ---------------------------------------------------------------------
-- supabase/migrations/20261028000012_cash_close_expenses.sql
-- ---------------------------------------------------------------------

-- Money per agenda, and who may see it. Dr. Everson reviews each day's
-- takings per agenda; the reception sees only the agendas whose staff earn a
-- commission (Estética, Depilação) and records the clinic's expenses.
-- Visibility is enforced here, so a hidden agenda's figures never reach the
-- reception's browser.

alter table agendas add column finance_shared boolean not null default false;
comment on column agendas.finance_shared is 'A recepção vê o faturamento desta agenda (comissões).';
update agendas set finance_shared = true
where normalize_text(name) like '%estetica%' or normalize_text(name) like '%depilacao%';

alter table payments add column agenda_id uuid references agendas (id) on delete set null;
create index payments_agenda_idx on payments (agenda_id, occurred_on);

-- A payment for a visit belongs to that visit's agenda.
create function payment_agenda_from_appointment() returns trigger
language plpgsql as $$
begin
    if new.appointment_id is not null
       and (new.agenda_id is null or (tg_op = 'UPDATE' and new.appointment_id is distinct from old.appointment_id)) then
        select agenda_id into new.agenda_id from appointments where id = new.appointment_id;
    end if;
    return new;
end;
$$;

create trigger payments_agenda_from_appointment before insert or update on payments
for each row execute function payment_agenda_from_appointment();

-- Existing payments (the FastClinic history included). Bumping
-- legacy_synced_at with updated_at keeps them refreshable by a later import.
update payments p
set agenda_id = a.agenda_id,
    legacy_synced_at = case when p.legacy_id is not null then now() else p.legacy_synced_at end
from appointments a
where a.id = p.appointment_id and p.agenda_id is null;

create function is_reception() returns boolean
language sql stable as $$ select current_staff_role() in ('admin', 'secretaria') $$;

-- The admin sees every payment; the rest of the team, counter sales (no
-- agenda) and the shared agendas only.
create function finance_visible(p_agenda_id uuid) returns boolean
language sql stable as $$
    select is_admin()
        or (is_staff() and (p_agenda_id is null or exists (select 1 from agendas a where a.id = p_agenda_id and a.finance_shared)))
$$;

drop policy payments_select on payments;
drop policy payments_update on payments;
create policy payments_select on payments for select to authenticated using (finance_visible(agenda_id));
create policy payments_update on payments for update to authenticated
    using (finance_visible(agenda_id)) with check ((select is_staff()));

create table expenses (
    id uuid primary key default gen_random_uuid(),
    occurred_on date not null default clinic_today(),
    description text not null check (btrim(description) <> ''),
    category text,
    amount numeric(12, 2) not null check (amount > 0),
    method payment_method,
    created_by uuid references staff (id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index expenses_occurred_on_idx on expenses (occurred_on);
create trigger expenses_set_updated_at before update on expenses for each row execute function set_updated_at();
create trigger expenses_set_created_by before insert on expenses for each row execute function set_created_by();

alter table expenses enable row level security;
create policy expenses_select on expenses for select to authenticated using ((select is_reception()));
create policy expenses_insert on expenses for insert to authenticated with check ((select is_reception()));
create policy expenses_update on expenses for update to authenticated using ((select is_reception())) with check ((select is_reception()));
create policy expenses_delete on expenses for delete to authenticated using ((select is_admin()));

-- The Financeiro screen: admin and reception. Runs as the caller, so each
-- one's totals cover only the payments they may see.
drop function finance_summary(date, date);
create function finance_summary(p_from date, p_to date) returns jsonb
language plpgsql stable as $$
declare
    v_result jsonb;
begin
    if not is_reception() and current_user not in ('postgres', 'service_role') then
        raise exception 'acesso_negado';
    end if;

    with p as (
        select * from payments where occurred_on between p_from and p_to
    ),
    e as (
        select * from expenses where occurred_on between p_from and p_to
    ),
    buckets as (
        -- Archived agendas (FastClinic's old ones) only when they have money in the period.
        select a.id, a.name, a.color, a.sort_order from agendas a
        where finance_visible(a.id) and (a.active or exists (select 1 from p where p.agenda_id = a.id))
        union all
        select null, 'Sem agenda (balcão)', null, 1000 where exists (select 1 from p where agenda_id is null)
    )
    select jsonb_build_object(
        'total_pago', coalesce((select sum(amount) from p where status = 'pago'), 0),
        'total_pendente', coalesce((select sum(amount) from p where status = 'pendente'), 0),
        'quantidade', (select count(*) from p),
        'por_forma', coalesce((
            select jsonb_agg(jsonb_build_object('forma', method, 'total', total, 'quantidade', n) order by total desc)
            from (select method, sum(amount) as total, count(*) as n from p where status = 'pago' group by method) m
        ), '[]'::jsonb),
        'por_dia', coalesce((
            select jsonb_agg(jsonb_build_object('dia', occurred_on, 'pago', pago, 'pendente', pendente) order by occurred_on)
            from (
                select occurred_on,
                       sum(amount) filter (where status = 'pago') as pago,
                       sum(amount) filter (where status = 'pendente') as pendente
                from p group by occurred_on
            ) d
        ), '[]'::jsonb),
        'por_agenda', coalesce((
            select jsonb_agg(jsonb_build_object(
                'agenda_id', b.id, 'nome', b.name, 'cor', b.color,
                'pago', coalesce((select sum(amount) from p where p.agenda_id is not distinct from b.id and status = 'pago'), 0),
                'pendente', coalesce((select sum(amount) from p where p.agenda_id is not distinct from b.id and status = 'pendente'), 0),
                'quantidade', (select count(*) from p where p.agenda_id is not distinct from b.id),
                'atendimentos', (select count(*) from appointments ap
                                 where b.id is not null and ap.agenda_id = b.id and ap.status = 'chegou'
                                   and (ap.starts_at at time zone clinic_tz())::date between p_from and p_to),
                'por_forma', coalesce((
                    select jsonb_agg(jsonb_build_object('forma', method, 'total', total) order by total desc)
                    from (select method, sum(amount) as total from p
                          where p.agenda_id is not distinct from b.id and status = 'pago' group by method) f
                ), '[]'::jsonb)
            ) order by b.sort_order, b.name)
            from buckets b
        ), '[]'::jsonb),
        'despesas_total', coalesce((select sum(amount) from e), 0),
        'despesas_por_categoria', coalesce((
            select jsonb_agg(jsonb_build_object('categoria', categoria, 'total', total, 'quantidade', n) order by total desc)
            from (select coalesce(nullif(btrim(category), ''), 'Sem categoria') as categoria, sum(amount) as total, count(*) as n
                  from e group by 1) c
        ), '[]'::jsonb)
    ) into v_result;

    return v_result;
end;
$$;

-- ---------------------------------------------------------------------
-- supabase/migrations/20261104000013_clinic_adjustments.sql
-- ---------------------------------------------------------------------

-- Adjustments the clinic asked for on 04/11/2026. The HTTP API keeps its
-- contract: status codes and appointment type names stay as they were; the
-- app only shows them differently ("A remarcar", "Retorno").

-- Agenda: "Remover da agenda" hides a booking without deleting it. A
-- cancelled booking that was not removed shows as "A remarcar".
alter table appointments add column removed_at timestamptz;
update appointments set removed_at = now() where cancel_reason = 'Excluído no FastClinic';

-- The name shown in the app; the API keeps matching on `name`.
alter table appointment_types add column display_name text;
update appointment_types t set display_name = 'Retorno'
from agendas a
where a.id = t.agenda_id and normalize_text(a.name) like '%everson%' and normalize_text(t.name) like 'avaliacao%';

-- The clinic's palette: one color per agenda (and the chat groups).
update agendas set color = case
    when normalize_text(name) like '%everson%' then '#6F8FB8'   -- azul-aço
    when normalize_text(name) like '%simone%' then '#E8B86D'    -- âmbar
    when normalize_text(name) like '%estetica%' then '#8CBF9A'  -- verde-folha
    when normalize_text(name) like '%depilacao%' then '#E58FA9' -- rosa-forte
    else color end
where active;

-- Saturday morning open for squeeze-ins: Dr. Everson and Simone until 14h.
insert into agenda_hours (agenda_id, weekday, start_time, end_time)
select a.id, 6, '08:00', '14:00'
from agendas a
where a.active and (normalize_text(a.name) like '%everson%' or normalize_text(a.name) like '%simone%')
  and not exists (select 1 from agenda_hours h where h.agenda_id = a.id and h.weekday = 6);

alter table chat_channels add column color text;
update chat_channels set color = '#E07A7A' where name = 'Recepção'; -- vermelho-suave

-- Each person silences their own sounds.
alter table staff add column mute_whatsapp boolean not null default false;
alter table staff add column mute_chat boolean not null default false;

create function set_my_notification_prefs(p_mute_whatsapp boolean, p_mute_chat boolean) returns void
language sql security definer set search_path = public as $$
    update staff set mute_whatsapp = p_mute_whatsapp, mute_chat = p_mute_chat where id = auth.uid()
$$;

-- Payment methods the clinic uses: Pix to Dr. Everson's or Simone's account.
-- The old values stay for existing entries.
alter type payment_method add value if not exists 'pix_everson';
alter type payment_method add value if not exists 'pix_simone';

-- Four-digit password in front of the Financeiro screen. The hash lives in a
-- table nobody can read; checks go through these functions, with a pause
-- after repeated misses.
create extension if not exists pgcrypto with schema extensions;

create table finance_pin (
    id boolean primary key default true check (id),
    pin_hash text not null,
    updated_at timestamptz not null default now()
);
alter table finance_pin enable row level security;

create table finance_pin_attempts (
    staff_id uuid not null references staff (id) on delete cascade,
    attempted_at timestamptz not null default now()
);
create index finance_pin_attempts_idx on finance_pin_attempts (staff_id, attempted_at);
alter table finance_pin_attempts enable row level security;

create function finance_pin_is_set() returns boolean
language sql stable security definer set search_path = public as $$
    select is_reception() and exists (select 1 from finance_pin)
$$;

create function set_finance_pin(p_pin text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
    if not is_admin() then raise exception 'acesso_negado'; end if;
    if p_pin !~ '^[0-9]{4}$' then raise exception 'senha_invalida'; end if;
    insert into finance_pin (id, pin_hash) values (true, crypt(p_pin, gen_salt('bf')))
    on conflict (id) do update set pin_hash = excluded.pin_hash, updated_at = now();
end;
$$;

-- 'ok', 'errada' or 'aguarde' (5 misses in 10 minutes).
create function check_finance_pin(p_pin text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare
    v_hash text;
begin
    if not is_reception() then raise exception 'acesso_negado'; end if;
    select pin_hash into v_hash from finance_pin;
    if v_hash is null then return 'ok'; end if;
    if (select count(*) from finance_pin_attempts
        where staff_id = auth.uid() and attempted_at > now() - interval '10 minutes') >= 5 then
        return 'aguarde';
    end if;
    if crypt(coalesce(p_pin, ''), v_hash) = v_hash then
        delete from finance_pin_attempts where staff_id = auth.uid();
        return 'ok';
    end if;
    insert into finance_pin_attempts (staff_id) values (auth.uid());
    return 'errada';
end;
$$;

-- Stock by sector (estética, depilação, café, limpeza...).
create table stock_sectors (
    id uuid primary key default gen_random_uuid(),
    name text not null check (btrim(name) <> ''),
    created_at timestamptz not null default now()
);
create unique index stock_sectors_name_idx on stock_sectors (normalize_text(btrim(name)));
alter table stock_products add column sector_id uuid references stock_sectors (id) on delete set null;
alter table stock_sectors enable row level security;
create or replace view stock_levels with (security_invoker = true) as
select p.id, p.name, p.unit, p.location, p.min_quantity, p.notes, p.active,
       coalesce(sum(case when m.type = 'entrada' then m.quantity else -m.quantity end), 0) as quantity,
       max(m.moved_at) as last_movement_at,
       p.sector_id
from stock_products p
left join stock_movements m on m.product_id = p.id
group by p.id;
create policy stock_sectors_all on stock_sectors for all to authenticated using ((select is_staff())) with check ((select is_staff()));

-- "Pessoal": the team and their vacations. Dr. Everson only.
create table employees (
    id uuid primary key default gen_random_uuid(),
    full_name text not null check (btrim(full_name) <> ''),
    role_title text,
    admission_date date,
    vacation_days_per_year integer not null default 30 check (vacation_days_per_year between 0 and 60),
    notes text,
    active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create trigger employees_set_updated_at before update on employees for each row execute function set_updated_at();

create table employee_vacations (
    id uuid primary key default gen_random_uuid(),
    employee_id uuid not null references employees (id) on delete cascade,
    starts_on date not null,
    ends_on date not null,
    notes text,
    created_at timestamptz not null default now(),
    check (ends_on >= starts_on)
);
create index employee_vacations_idx on employee_vacations (employee_id, starts_on);

alter table employees enable row level security;
alter table employee_vacations enable row level security;
create policy employees_admin on employees for all to authenticated using ((select is_admin())) with check ((select is_admin()));
create policy employee_vacations_admin on employee_vacations for all to authenticated using ((select is_admin())) with check ((select is_admin()));

-- "Administrativo": free notes and a to-do list with reminders, for the
-- reception and Dr. Everson.
create table admin_notes (
    id uuid primary key default gen_random_uuid(),
    title text,
    body text not null default '',
    pinned boolean not null default false,
    created_by uuid references staff (id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create trigger admin_notes_set_updated_at before update on admin_notes for each row execute function set_updated_at();
create trigger admin_notes_set_created_by before insert on admin_notes for each row execute function set_created_by();

create table admin_tasks (
    id uuid primary key default gen_random_uuid(),
    title text not null check (btrim(title) <> ''),
    notes text,
    remind_at timestamptz,
    done_at timestamptz,
    done_by uuid references staff (id) on delete set null,
    created_by uuid references staff (id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index admin_tasks_open_idx on admin_tasks (remind_at) where done_at is null;
create trigger admin_tasks_set_updated_at before update on admin_tasks for each row execute function set_updated_at();
create trigger admin_tasks_set_created_by before insert on admin_tasks for each row execute function set_created_by();

alter table admin_notes enable row level security;
alter table admin_tasks enable row level security;
create policy admin_notes_reception on admin_notes for all to authenticated using ((select is_reception())) with check ((select is_reception()));
create policy admin_tasks_reception on admin_tasks for all to authenticated using ((select is_reception())) with check ((select is_reception()));

-- Reactivation campaign: when a patient was last contacted for it.
alter table patients add column reactivation_contacted_at timestamptz;

-- Merging duplicate patients. A merged patient's FastClinic id keeps
-- pointing at the patient that stayed, so a later import does not bring the
-- duplicate back.
create table patient_legacy_aliases (
    legacy_id integer primary key,
    patient_id uuid not null references patients (id) on delete cascade
);
alter table patient_legacy_aliases enable row level security;
create policy patient_legacy_aliases_select on patient_legacy_aliases for select to authenticated using ((select is_staff()));

create function patient_by_legacy(p_legacy_id integer) returns uuid
language sql stable as $$
    select coalesce(
        (select patient_id from patient_legacy_aliases where legacy_id = p_legacy_id),
        (select id from patients where legacy_id = p_legacy_id)
    )
$$;

-- Pairs the admin said are different people.
create table patient_not_duplicates (
    patient_a uuid not null references patients (id) on delete cascade,
    patient_b uuid not null references patients (id) on delete cascade,
    primary key (patient_a, patient_b),
    check (patient_a < patient_b)
);
alter table patient_not_duplicates enable row level security;
create policy patient_not_duplicates_admin on patient_not_duplicates for all to authenticated
    using ((select is_admin())) with check ((select is_admin()));

-- Likely duplicates: same CPF, same phone and first name, or the same full
-- name with no conflicting birth date.
create function duplicate_patient_pairs(p_limit integer default 200)
returns table (patient_a uuid, patient_b uuid, motivo text)
language plpgsql stable security definer set search_path = public as $$
begin
    if not is_admin() then raise exception 'acesso_negado'; end if;
    return query
    with keys as (
        select id, 'CPF igual' as why, 'c' || only_digits(cpf) as k
        from patients where length(only_digits(cpf)) = 11
        union all
        select id, 'Mesmo telefone e primeiro nome', 'p' || phone_key(phone) || ':' || split_part(normalize_text(btrim(full_name)), ' ', 1)
        from patients where phone_key(phone) is not null
        union all
        select id, 'Mesmo nome completo', 'n' || regexp_replace(normalize_text(btrim(full_name)), '\s+', ' ', 'g')
        from patients where btrim(full_name) ~ '\s'
    ),
    groups as (
        select k, min(why) as why, array_agg(id order by id) as ids
        from keys group by k having count(*) between 2 and 6
    ),
    pairs as (
        select distinct on (least(a, b), greatest(a, b)) least(a, b) as pa, greatest(a, b) as pb, g.why
        from groups g, unnest(g.ids) a, unnest(g.ids) b
        where a < b
        order by least(a, b), greatest(a, b), g.why
    )
    select p.pa, p.pb, p.why
    from pairs p
    join patients x on x.id = p.pa
    join patients y on y.id = p.pb
    where not exists (select 1 from patient_not_duplicates d where d.patient_a = p.pa and d.patient_b = p.pb)
      and (x.birth_date is null or y.birth_date is null or x.birth_date = y.birth_date or p.why = 'CPF igual')
    order by p.why, x.full_name
    limit p_limit;
end;
$$;

-- Moves everything from p_drop to p_keep, fills p_keep's empty fields, and
-- deletes p_drop. Admin only.
create function merge_patients(p_keep uuid, p_drop uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
    k patients;
    d patients;
begin
    if not is_admin() then raise exception 'acesso_negado'; end if;
    if p_keep = p_drop then raise exception 'mesmo_paciente'; end if;
    select * into k from patients where id = p_keep for update;
    select * into d from patients where id = p_drop for update;
    if k.id is null or d.id is null then raise exception 'paciente_nao_encontrado'; end if;

    update appointments set patient_id = p_keep where patient_id = p_drop;
    update record_entries set patient_id = p_keep where patient_id = p_drop;
    update record_attachments set patient_id = p_keep where patient_id = p_drop;
    update payments set patient_id = p_keep where patient_id = p_drop;
    update whatsapp_messages set patient_id = p_keep where patient_id = p_drop;
    delete from birthday_messages b where b.patient_id = p_drop
        and exists (select 1 from birthday_messages o where o.patient_id = p_keep and o.year = b.year);
    update birthday_messages set patient_id = p_keep where patient_id = p_drop;
    delete from reminders r where r.patient_id = p_drop and r.status = 'pendente'
        and exists (select 1 from reminders o where o.patient_id = p_keep and o.procedure_id = r.procedure_id and o.status = 'pendente');
    update reminders set patient_id = p_keep where patient_id = p_drop;
    delete from reminder_recalc_queue where patient_id = p_drop;
    update patient_legacy_aliases set patient_id = p_keep where patient_id = p_drop;
    if d.legacy_id is not null then
        insert into patient_legacy_aliases (legacy_id, patient_id) values (d.legacy_id, p_keep)
        on conflict (legacy_id) do update set patient_id = excluded.patient_id;
    end if;

    delete from patients where id = p_drop;
    update patients set
        phone = coalesce(k.phone, d.phone),
        phone_alt = coalesce(k.phone_alt, case when phone_key(d.phone) is distinct from phone_key(coalesce(k.phone, d.phone)) then d.phone end, d.phone_alt),
        cpf = coalesce(k.cpf, d.cpf),
        email = coalesce(k.email, d.email),
        birth_date = coalesce(k.birth_date, d.birth_date),
        address = coalesce(k.address, d.address),
        profession = coalesce(k.profession, d.profession),
        notes = nullif(concat_ws(E'\n', k.notes, case when d.notes is distinct from k.notes then d.notes end), ''),
        allow_messages = k.allow_messages and d.allow_messages,
        legacy_id = coalesce(k.legacy_id, d.legacy_id)
    where id = p_keep;
    if k.legacy_id is null and d.legacy_id is not null then
        delete from patient_legacy_aliases where legacy_id = d.legacy_id;
    end if;
    perform recompute_patient_reminders(p_keep);
end;
$$;

-- ---------------------------------------------------------------------
-- supabase/migrations/20261105000014_no_show_webhook.sql
-- ---------------------------------------------------------------------

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

-- ---------------------------------------------------------------------
-- supabase/migrations/20261105000015_estetica_simone_hours.sql
-- ---------------------------------------------------------------------

-- Hours sent by the clinic on 05/11.
--
-- Estética, Monday to Friday: one-hour slots at 8:30, 9:30, 10:30, 11:30,
-- 13:30, 14:30, 15:30, 16:30 and 17:30; closed only for lunch (12:30–13:30).
-- Saturday is unchanged.
--
-- Simone: afternoons start at 13:30 instead of 14:00 (the slot at 13:30 is
-- added on the days that had 14:00). Other windows are unchanged.
--
-- On a fresh install the agendas do not exist yet (the seed comes after), so
-- this does nothing there.

do $$
declare
    v_estetica uuid := (select id from agendas where name = 'Estética');
    v_simone uuid := (select id from agendas where name = 'Simone Rezeck');
    d integer;
begin
    if v_estetica is not null then
        delete from agenda_hours where agenda_id = v_estetica and weekday between 1 and 5;
        delete from agenda_slot_times where agenda_id = v_estetica and weekday between 1 and 5;
        for d in 1..5 loop
            insert into agenda_hours (agenda_id, weekday, start_time, end_time) values
                (v_estetica, d, '08:30', '12:30'),
                (v_estetica, d, '13:30', '18:30');
            insert into agenda_slot_times (agenda_id, weekday, start_time)
            select v_estetica, d, t::time
            from unnest(array['08:30', '09:30', '10:30', '11:30', '13:30', '14:30', '15:30', '16:30', '17:30']) as t
            on conflict do nothing;
        end loop;
    end if;

    if v_simone is not null then
        insert into agenda_slot_times (agenda_id, weekday, start_time)
        select v_simone, h.weekday, '13:30'
        from agenda_hours h
        where h.agenda_id = v_simone and h.start_time = '14:00'
          and exists (select 1 from agenda_slot_times st where st.agenda_id = v_simone and st.weekday = h.weekday)
        on conflict do nothing;
        update agenda_hours set start_time = '13:30'
        where agenda_id = v_simone and start_time = '14:00'
          and not exists (
              select 1 from agenda_hours o
              where o.agenda_id = agenda_hours.agenda_id and o.weekday = agenda_hours.weekday
                and o.id <> agenda_hours.id and o.end_time > '13:30' and o.start_time < '14:00'
          );
    end if;
end;
$$;

-- ---------------------------------------------------------------------
-- supabase/migrations/20261105000016_chat_alerts_per_group.sql
-- ---------------------------------------------------------------------

-- Team chat alerts per group: each person chooses which groups beep, pop a
-- notification and count on the menu bubble. Messages of a silenced group
-- still show (with their unread count) in the Equipe list. The global switch
-- (mute_chat) keeps silencing all of them.
alter table staff add column chat_muted_channels uuid[] not null default '{}';

create function set_my_muted_channels(p_channels uuid[]) returns void
language sql security definer set search_path = public as $$
    update staff
    set chat_muted_channels = coalesce(
        (select array_agg(distinct c) from unnest(p_channels) c where exists (select 1 from chat_channels ch where ch.id = c)),
        '{}')
    where id = auth.uid()
$$;

-- Start sensibly: someone with an agenda of their own (Dr. Everson, for
-- example) is no longer alerted by the groups of the other agendas. The
-- groups for everyone (Recepção) and the ones without an agenda keep alerting.
update staff s
set chat_muted_channels = coalesce(
    (select array_agg(c.id) from chat_channels c where c.agenda_id is not null and c.agenda_id <> s.agenda_id),
    '{}')
where s.agenda_id is not null;

-- ---------------------------------------------------------------------
-- supabase/migrations/20261106000017_finance_per_person.sql
-- ---------------------------------------------------------------------

-- Financeiro, 06/11:
--  * each person has their own 4-digit password (Dr. Everson sets them in
--    Ajustes → Financeiro); the old single password still works for whoever
--    has no password of their own;
--  * once anyone has a password of their own, a secretary without one (and
--    without the old single password) cannot open the Financeiro;
--  * the reception sees every agenda except Dr. Everson's (Simone's opens to
--    the reception too).

create table staff_finance_pins (
    staff_id uuid primary key references staff (id) on delete cascade,
    pin_hash text not null,
    updated_at timestamptz not null default now()
);
-- No policies: read and written only through the functions below.
alter table staff_finance_pins enable row level security;

-- 'ok', 'errada', 'aguarde' (5 misses in 10 minutes) or 'sem_senha' (this
-- person has no password and others do: ask Dr. Everson for one).
create or replace function check_finance_pin(p_pin text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare
    v_hash text;
begin
    if not is_reception() then raise exception 'acesso_negado'; end if;
    select pin_hash into v_hash from staff_finance_pins where staff_id = auth.uid();
    if v_hash is null then
        select pin_hash into v_hash from finance_pin;
    end if;
    if v_hash is null then
        if is_admin() or not exists (select 1 from staff_finance_pins) then return 'ok'; end if;
        return 'sem_senha';
    end if;
    if (select count(*) from finance_pin_attempts
        where staff_id = auth.uid() and attempted_at > now() - interval '10 minutes') >= 5 then
        return 'aguarde';
    end if;
    if crypt(coalesce(p_pin, ''), v_hash) = v_hash then
        delete from finance_pin_attempts where staff_id = auth.uid();
        return 'ok';
    end if;
    insert into finance_pin_attempts (staff_id) values (auth.uid());
    return 'errada';
end;
$$;

-- Admin: set (4 digits) or remove (null) someone's password.
create function set_staff_finance_pin(p_staff_id uuid, p_pin text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
    if not is_admin() then raise exception 'acesso_negado'; end if;
    if not exists (
        select 1 from staff s
        where s.id = p_staff_id and s.role in ('admin', 'secretaria')
          and (not s.is_superadmin or is_superadmin())
    ) then
        raise exception 'usuario_invalido';
    end if;
    if p_pin is null or p_pin = '' then
        delete from staff_finance_pins where staff_id = p_staff_id;
    else
        if p_pin !~ '^[0-9]{4}$' then raise exception 'senha_invalida'; end if;
        insert into staff_finance_pins (staff_id, pin_hash) values (p_staff_id, crypt(p_pin, gen_salt('bf')))
        on conflict (staff_id) do update set pin_hash = excluded.pin_hash, updated_at = now();
    end if;
    delete from finance_pin_attempts where staff_id = p_staff_id;
end;
$$;

-- Admin: who can open the Financeiro, and who already has a password.
create function finance_pin_people()
returns table (staff_id uuid, full_name text, role staff_role, has_pin boolean, updated_at timestamptz)
language sql stable security definer set search_path = public as $$
    select s.id, s.full_name, s.role, p.staff_id is not null, p.updated_at
    from staff s
    left join staff_finance_pins p on p.staff_id = s.id
    where is_admin() and s.active and s.role in ('admin', 'secretaria')
      and (not s.is_superadmin or is_superadmin())
    order by s.role, s.full_name
$$;

-- Admin: whether the old single password exists, and removing it.
create function finance_general_pin_is_set() returns boolean
language sql stable security definer set search_path = public as $$
    select is_admin() and exists (select 1 from finance_pin)
$$;

create function remove_general_finance_pin() returns void
language plpgsql security definer set search_path = public as $$
begin
    if not is_admin() then raise exception 'acesso_negado'; end if;
    delete from finance_pin;
end;
$$;

-- The reception sees every agenda except Dr. Everson's.
update agendas set finance_shared = true where name = 'Simone Rezeck';

-- ---------------------------------------------------------------------
-- supabase/migrations/20261106000018_agenda_hours_0611.sql
-- ---------------------------------------------------------------------

-- Hours sent by Dr. Everson on 06/11 (they win over the ones of 05/11):
--
--   afternoons start at 13:30 in every agenda, Monday to Friday;
--   mornings start at 8:30 and open only on:
--     Dr. Everson and Simone ...... Wednesday and Saturday
--     Depilação ................... Wednesday, Friday and Saturday
--     Estética .................... Tuesday, Wednesday and Saturday
--
-- Closing times stay as they were. Where an agenda works with fixed start
-- times, the times outside the new windows go away and the new half hours
-- (8:30, 13:00-15:00 gaps) are added on its 30-minute rhythm. Bookings
-- already made are not touched. On a fresh install (no agendas yet) this does
-- nothing.

do $$
declare
    r record;
    v_agenda uuid;
    v_morning_days integer[];
    v_first time;
    d integer;
begin
    for r in select * from (values
        ('Dr. Everson Rezeck', array[3, 6]),
        ('Simone Rezeck', array[3, 6]),
        ('Depilação a laser', array[3, 5, 6]),
        ('Estética', array[2, 3, 6])
    ) as t(name, morning_days)
    loop
        v_agenda := (select id from agendas where name = r.name);
        continue when v_agenda is null;
        v_morning_days := r.morning_days;

        for d in 1..6 loop
            -- Mornings (windows starting before noon).
            if not (d = any (v_morning_days)) then
                delete from agenda_slot_times where agenda_id = v_agenda and weekday = d and start_time < '12:00';
                -- a window running from morning into the afternoon keeps its afternoon
                update agenda_hours set start_time = '13:30'
                where agenda_id = v_agenda and weekday = d and start_time < '12:00' and end_time > '13:30';
                delete from agenda_hours where agenda_id = v_agenda and weekday = d and start_time < '12:00';
            elsif exists (select 1 from agenda_hours where agenda_id = v_agenda and weekday = d and start_time < '12:00') then
                select min(start_time) into v_first from agenda_slot_times where agenda_id = v_agenda and weekday = d and start_time < '12:00';
                -- Fixed times: drop the ones before 8:30, fill 8:30 up to the first one.
                if v_first is not null then
                    delete from agenda_slot_times where agenda_id = v_agenda and weekday = d and start_time < '08:30';
                    insert into agenda_slot_times (agenda_id, weekday, start_time)
                    select v_agenda, d, t::time from generate_series(timestamp '2000-01-01 08:30', timestamp '2000-01-01 00:00' + v_first - interval '1 minute', interval '30 minutes') t
                    on conflict do nothing;
                    if not exists (select 1 from agenda_slot_times where agenda_id = v_agenda and weekday = d and start_time < '12:00') then
                        insert into agenda_slot_times values (v_agenda, d, '08:30') on conflict do nothing;
                    end if;
                end if;
                update agenda_hours set start_time = '08:30' where agenda_id = v_agenda and weekday = d and start_time < '12:00';
            else
                -- A new morning: 8:30 to 12:00, on the agenda's 30-minute rhythm
                -- when it works with fixed times.
                insert into agenda_hours (agenda_id, weekday, start_time, end_time) values (v_agenda, d, '08:30', '12:00');
                if exists (select 1 from agenda_slot_times where agenda_id = v_agenda and weekday = d) then
                    insert into agenda_slot_times (agenda_id, weekday, start_time)
                    select v_agenda, d, t::time from generate_series(timestamp '2000-01-01 08:30', timestamp '2000-01-01 11:30', interval '30 minutes') t
                    on conflict do nothing;
                end if;
            end if;

            -- Afternoons (Monday to Friday): start at 13:30.
            if d between 1 and 5 then
                select min(start_time) into v_first from agenda_slot_times where agenda_id = v_agenda and weekday = d and start_time >= '12:00';
                if v_first is not null and v_first > '13:30' then
                    insert into agenda_slot_times (agenda_id, weekday, start_time)
                    select v_agenda, d, t::time from generate_series(timestamp '2000-01-01 13:30', timestamp '2000-01-01 00:00' + v_first - interval '1 minute', interval '30 minutes') t
                    on conflict do nothing;
                end if;
                update agenda_hours set start_time = '13:30'
                where agenda_id = v_agenda and weekday = d and start_time >= '12:00' and start_time <> '13:30';
            end if;
        end loop;
    end loop;

    -- Estética on Saturday: the same one-hour rhythm as the week (8:30 to 13:30).
    v_agenda := (select id from agendas where name = 'Estética');
    if v_agenda is not null and exists (select 1 from agenda_slot_times where agenda_id = v_agenda and weekday = 6) then
        delete from agenda_slot_times where agenda_id = v_agenda and weekday = 6;
        insert into agenda_slot_times (agenda_id, weekday, start_time)
        select v_agenda, 6, t::time
        from generate_series(timestamp '2000-01-01 08:30', timestamp '2000-01-01 00:00' + (select max(end_time) from agenda_hours where agenda_id = v_agenda and weekday = 6) - interval '60 minutes', interval '60 minutes') t;
    end if;
end;
$$;

-- ---------------------------------------------------------------------
-- supabase/migrations/20261106000019_block_series.sql
-- ---------------------------------------------------------------------

-- Recurring blocks: a block that repeats is stored as one row per day, all
-- with the same series_id, so availability (and the WhatsApp agent) needs no
-- change and one day can still be unblocked on its own.
alter table agenda_blocks add column series_id uuid;
create index agenda_blocks_series_idx on agenda_blocks (series_id) where series_id is not null;

-- ---------------------------------------------------------------------
-- supabase/migrations/20261106000020_agenda_openings.sql
-- ---------------------------------------------------------------------

-- One-off openings: the reverse of a block. An agenda opens on one specific
-- day and time (e.g. "this Monday at 11:00") without changing its weekly
-- hours. Anyone on the team can open or remove one, as with blocks. Booking
-- (screen, API and the WhatsApp agent) treats it as opening hours.
create table agenda_openings (
    id uuid primary key default gen_random_uuid(),
    agenda_id uuid not null references agendas (id) on delete cascade,
    starts_at timestamptz not null,
    ends_at timestamptz not null,
    reason text,
    created_by uuid references staff (id) on delete set null,
    created_at timestamptz not null default now(),
    check (ends_at > starts_at)
);
create index agenda_openings_time_idx on agenda_openings (agenda_id, starts_at);
create trigger agenda_openings_set_created_by before insert on agenda_openings for each row execute function set_created_by();

alter table agenda_openings enable row level security;
create policy agenda_openings_all on agenda_openings for all to authenticated
    using ((select is_staff())) with check ((select is_staff()));

create or replace function fits_working_hours(p_agenda_id uuid, p_starts_at timestamptz, p_ends_at timestamptz)
returns boolean
language sql stable as $$
    select exists (
        select 1
        from agenda_hours h
        where h.agenda_id = p_agenda_id
          and h.weekday = extract(dow from (p_starts_at at time zone clinic_tz()))
          and p_starts_at >= local_timestamp((p_starts_at at time zone clinic_tz())::date, h.start_time)
          and p_ends_at <= local_timestamp((p_starts_at at time zone clinic_tz())::date, h.end_time)
    ) or exists (
        select 1
        from agenda_slot_times st
        where st.agenda_id = p_agenda_id
          and st.weekday = extract(dow from (p_starts_at at time zone clinic_tz()))
          and st.start_time = (p_starts_at at time zone clinic_tz())::time
    ) or exists (
        select 1
        from agenda_openings o
        where o.agenda_id = p_agenda_id
          and p_starts_at >= o.starts_at
          and p_ends_at <= o.ends_at
    )
$$;

-- Free slots for one day: the weekly hours (fixed start times, or walked
-- every slot_step_minutes), plus the one-off openings of that day. In an
-- opening, slots follow the booking length when the agenda works with fixed
-- start times (an hour for Estética), otherwise its step.
create or replace function available_slots(
    p_date date,
    p_agenda_id uuid default null,
    p_appointment_type_id uuid default null,
    p_duration_minutes integer default null
)
returns table (
    agenda_id uuid,
    agenda_name text,
    appointment_type_id uuid,
    starts_at timestamptz,
    ends_at timestamptz
)
language sql stable as $$
    with ag as (
        select a.id, a.name, a.sort_order, a.slot_step_minutes, t.id as type_id,
               coalesce(p_duration_minutes, t.duration_minutes, 30) as duration
        from agendas a
        left join lateral (
            select at.id, at.duration_minutes
            from appointment_types at
            where at.agenda_id = a.id and at.active
              and case when p_appointment_type_id is null then at.is_default
                       else at.id = p_appointment_type_id end
            limit 1
        ) t on true
        where a.active
          and (p_agenda_id is null or a.id = p_agenda_id)
          and (p_appointment_type_id is null or t.id is not null)
    ),
    fixed as (
        select ag.id, ag.name, ag.sort_order, ag.type_id,
               local_timestamp(p_date, st.start_time) as slot_start, ag.duration
        from ag
        join agenda_slot_times st on st.agenda_id = ag.id and st.weekday = extract(dow from p_date)
    ),
    walked as (
        select ag.id, ag.name, ag.sort_order, ag.type_id, s.slot_start, ag.duration
        from ag
        join agenda_hours h on h.agenda_id = ag.id and h.weekday = extract(dow from p_date)
        cross join lateral generate_series(
            local_timestamp(p_date, h.start_time),
            local_timestamp(p_date, h.end_time) - make_interval(mins => ag.duration),
            make_interval(mins => ag.slot_step_minutes)
        ) as s(slot_start)
        where not exists (select 1 from fixed f where f.id = ag.id)
    ),
    opened as (
        select ag.id, ag.name, ag.sort_order, ag.type_id, s.slot_start, ag.duration
        from ag
        join agenda_openings o on o.agenda_id = ag.id
            and o.starts_at < local_timestamp(p_date + 1, '00:00')
            and o.ends_at > local_timestamp(p_date, '00:00')
        cross join lateral generate_series(
            greatest(o.starts_at, local_timestamp(p_date, '00:00')),
            least(o.ends_at, local_timestamp(p_date + 1, '00:00')) - make_interval(mins => ag.duration),
            make_interval(mins => case
                when exists (select 1 from agenda_slot_times st where st.agenda_id = ag.id) then ag.duration
                else ag.slot_step_minutes end)
        ) as s(slot_start)
    ),
    candidates as (
        select c.id, c.name, c.sort_order, c.type_id, c.slot_start,
               default_end(c.id, c.slot_start, c.duration) as slot_end
        from (select * from fixed union all select * from walked union all select * from opened) c
    )
    select distinct on (c.sort_order, c.name, c.slot_start) c.id, c.name, c.type_id, c.slot_start, c.slot_end
    from candidates c
    where c.slot_start > now()
      and not slot_is_taken(c.id, c.slot_start, c.slot_end)
    order by c.sort_order, c.name, c.slot_start
$$;

-- ---------------------------------------------------------------------
-- supabase/migrations/20261110000021_campaigns.sql
-- ---------------------------------------------------------------------

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

-- ---------------------------------------------------------------------
-- supabase/migrations/20261112000022_performance.sql
-- ---------------------------------------------------------------------

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

-- ---------------------------------------------------------------------
-- supabase/migrations/20261112000023_finance_summary_speed.sql
-- ---------------------------------------------------------------------

-- Financeiro report (8 s for a month): counting each agenda's visits
-- converted every booking's time to a date before comparing, so it read the
-- agenda's whole history. Comparing the timestamp with the period's bounds
-- uses the (agenda_id, starts_at) index. Same result.
create or replace function finance_summary(p_from date, p_to date) returns jsonb
language plpgsql stable as $$
declare
    v_result jsonb;
begin
    if not is_reception() and current_user not in ('postgres', 'service_role') then
        raise exception 'acesso_negado';
    end if;

    with p as (
        select * from payments where occurred_on between p_from and p_to
    ),
    e as (
        select * from expenses where occurred_on between p_from and p_to
    ),
    buckets as (
        -- Archived agendas (FastClinic's old ones) only when they have money in the period.
        select a.id, a.name, a.color, a.sort_order from agendas a
        where finance_visible(a.id) and (a.active or exists (select 1 from p where p.agenda_id = a.id))
        union all
        select null, 'Sem agenda (balcão)', null, 1000 where exists (select 1 from p where agenda_id is null)
    )
    select jsonb_build_object(
        'total_pago', coalesce((select sum(amount) from p where status = 'pago'), 0),
        'total_pendente', coalesce((select sum(amount) from p where status = 'pendente'), 0),
        'quantidade', (select count(*) from p),
        'por_forma', coalesce((
            select jsonb_agg(jsonb_build_object('forma', method, 'total', total, 'quantidade', n) order by total desc)
            from (select method, sum(amount) as total, count(*) as n from p where status = 'pago' group by method) m
        ), '[]'::jsonb),
        'por_dia', coalesce((
            select jsonb_agg(jsonb_build_object('dia', occurred_on, 'pago', pago, 'pendente', pendente) order by occurred_on)
            from (
                select occurred_on,
                       sum(amount) filter (where status = 'pago') as pago,
                       sum(amount) filter (where status = 'pendente') as pendente
                from p group by occurred_on
            ) d
        ), '[]'::jsonb),
        'por_agenda', coalesce((
            select jsonb_agg(jsonb_build_object(
                'agenda_id', b.id, 'nome', b.name, 'cor', b.color,
                'pago', coalesce((select sum(amount) from p where p.agenda_id is not distinct from b.id and status = 'pago'), 0),
                'pendente', coalesce((select sum(amount) from p where p.agenda_id is not distinct from b.id and status = 'pendente'), 0),
                'quantidade', (select count(*) from p where p.agenda_id is not distinct from b.id),
                'atendimentos', (select count(*) from appointments ap
                                 where b.id is not null and ap.agenda_id = b.id and ap.status = 'chegou'
                                   and ap.starts_at >= local_timestamp(p_from, '00:00')
                                   and ap.starts_at < local_timestamp(p_to + 1, '00:00')),
                'por_forma', coalesce((
                    select jsonb_agg(jsonb_build_object('forma', method, 'total', total) order by total desc)
                    from (select method, sum(amount) as total from p
                          where p.agenda_id is not distinct from b.id and status = 'pago' group by method) f
                ), '[]'::jsonb)
            ) order by b.sort_order, b.name)
            from buckets b
        ), '[]'::jsonb),
        'despesas_total', coalesce((select sum(amount) from e), 0),
        'despesas_por_categoria', coalesce((
            select jsonb_agg(jsonb_build_object('categoria', categoria, 'total', total, 'quantidade', n) order by total desc)
            from (select coalesce(nullif(btrim(category), ''), 'Sem categoria') as categoria, sum(amount) as total, count(*) as n
                  from e group by 1) c
        ), '[]'::jsonb)
    ) into v_result;

    return v_result;
end;
$$;

-- ---------------------------------------------------------------------
-- supabase/migrations/20261113000024_whatsapp_reliability.sql
-- ---------------------------------------------------------------------

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

-- ---------------------------------------------------------------------
-- supabase/migrations/20261113000025_whatsapp_lid_map.sql
-- ---------------------------------------------------------------------

-- Newer WhatsApp accounts identify a contact by an anonymous "@lid" id
-- instead of the phone. Evolution usually sends the phone along
-- (remoteJidAlt / senderPn); when it does, the pair is remembered, so a
-- later message that only carries the "@lid" id still lands in the same
-- conversation (one per phone) and is linked to the patient.

create table whatsapp_lid_map (
    lid text primary key,
    phone_jid text not null,
    updated_at timestamptz not null default now()
);
alter table whatsapp_lid_map enable row level security;
-- No policies: only the server (webhook, sync) reads and writes it.

-- ---------------------------------------------------------------------
-- supabase/migrations/20261113000026_whatsapp_list_speed.sql
-- ---------------------------------------------------------------------

-- The WhatsApp conversation list took over two minutes for a logged-in user
-- (and so came back empty: the app gives up after 8 seconds). Each
-- conversation looks its patient up by phone; under the patients' access
-- rules the database may not use the phone index for that (phone_key is not
-- "leakproof"), so it read all patients once per conversation. The lookup
-- now runs with the owner's rights, which uses the index; it only returns
-- an id, and the patient's name still comes through the normal rules.
create or replace function match_patient_by_phone(p_digits text) returns uuid
language sql stable security definer set search_path = public as $$
    select id from patients
    where phone_key(p_digits) is not null
      and (phone_key(phone) = phone_key(p_digits) or phone_key(phone_alt) = phone_key(p_digits))
    order by updated_at desc
    limit 1
$$;
revoke execute on function match_patient_by_phone(text) from anon;

-- Messages already linked at arrival don't need the lookup at all; link the
-- ones that arrived before their patient was registered.
update whatsapp_messages m
set patient_id = match_patient_by_phone(m.phone_digits)
where m.patient_id is null and m.phone_digits is not null and match_patient_by_phone(m.phone_digits) is not null;

-- ---------------------------------------------------------------------
-- supabase/migrations/20261113000027_whatsapp_watchdog.sql
-- ---------------------------------------------------------------------

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

-- ---------------------------------------------------------------------
-- supabase/migrations/20261113000028_whatsapp_health_window.sql
-- ---------------------------------------------------------------------

-- The "arriving late" warning looked at the last two hours, so it stayed up
-- for two hours after the connection was fixed. It now looks at the last
-- 30 minutes.
create or replace function whatsapp_health()
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
          where created_at > now() - interval '30 minutes' and sent_by is null),
        (select count(*)::integer
           from whatsapp_messages
          where created_at > now() - interval '30 minutes' and sent_by is null
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

-- ---------------------------------------------------------------------
-- supabase/migrations/20261113000029_record_edits.sql
-- ---------------------------------------------------------------------

-- Prontuário: anyone on the team can correct an entry (text and date) and
-- its attachments, including the ones imported from FastClinic, which have
-- no author. Every change is kept: who changed it, when, and what it said
-- before. Deleting an entry stays with its author and the administrator.

alter table record_entries add column edited_at timestamptz;
alter table record_entries add column edited_by uuid references staff (id) on delete set null;

create table record_entry_revisions (
    id bigint generated always as identity primary key,
    entry_id uuid not null references record_entries (id) on delete cascade,
    content text not null,
    entry_at timestamptz not null,
    -- who wrote this version (the author, or whoever edited it last)
    written_by uuid references staff (id) on delete set null,
    written_at timestamptz,
    replaced_by uuid references staff (id) on delete set null,
    replaced_at timestamptz not null default now()
);
create index record_entry_revisions_entry_idx on record_entry_revisions (entry_id, replaced_at desc);

alter table record_entry_revisions enable row level security;
create policy record_entry_revisions_select on record_entry_revisions for select to authenticated using ((select is_staff()));

-- Edits made in the app (a logged-in user) are recorded; the FastClinic
-- re-import (no user) only refreshes the text, as before.
create function record_entries_keep_revision() returns trigger
language plpgsql security definer set search_path = public as $$
begin
    if auth.uid() is null then
        return new;
    end if;
    if new.content is distinct from old.content or new.entry_at is distinct from old.entry_at then
        insert into record_entry_revisions (entry_id, content, entry_at, written_by, written_at, replaced_by)
        values (old.id, old.content, old.entry_at, coalesce(old.edited_by, old.author_id), coalesce(old.edited_at, old.created_at), auth.uid());
        new.edited_at := now();
        new.edited_by := auth.uid();
    end if;
    -- the authorship of the entry never changes
    new.author_id := old.author_id;
    return new;
end;
$$;

create trigger record_entries_keep_revision before update on record_entries
for each row execute function record_entries_keep_revision();

drop policy record_entries_update on record_entries;
create policy record_entries_update on record_entries for update to authenticated
    using ((select is_staff())) with check ((select is_staff()));

drop policy record_attachments_delete on record_attachments;
create policy record_attachments_delete on record_attachments for delete to authenticated
    using ((select is_staff()));

-- ---------------------------------------------------------------------
-- supabase/seed.sql
-- ---------------------------------------------------------------------

-- Starting configuration for the Clínica Dr. Everson Rezeck.
-- Opening hours are a placeholder (Mon–Fri 08:00–18:00, and Saturday until
-- 14h for the two doctors' squeeze-ins) to be adjusted in Ajustes.
-- Colors are the clinic's palette: azul-aço, âmbar, verde-folha, rosa-forte.

-- The reception sees the takings of every agenda except Dr. Everson's.
insert into agendas (name, color, slot_step_minutes, sort_order, finance_shared) values
    ('Dr. Everson Rezeck', '#6F8FB8', 20, 1, false),
    ('Simone Rezeck', '#E8B86D', 20, 2, true),
    ('Estética', '#8CBF9A', 30, 3, true),
    ('Depilação a laser', '#E58FA9', 30, 4, true);

insert into agenda_hours (agenda_id, weekday, start_time, end_time)
select a.id, d.weekday, '08:00', '18:00'
from agendas a cross join generate_series(1, 5) as d(weekday);

insert into agenda_hours (agenda_id, weekday, start_time, end_time)
select id, 6, '08:00', '14:00' from agendas where name in ('Dr. Everson Rezeck', 'Simone Rezeck');

-- display_name is what the app shows; the API matches on name.
insert into appointment_types (agenda_id, name, display_name, duration_minutes, is_default, sort_order)
select id, 'Consulta', null, 40, true, 1 from agendas where name = 'Dr. Everson Rezeck'
union all
select id, 'Avaliação estética', 'Retorno', 20, false, 2 from agendas where name = 'Dr. Everson Rezeck'
union all
select id, 'Consulta', null, 40, true, 1 from agendas where name = 'Simone Rezeck'
union all
select id, 'Consulta', null, 60, true, 1 from agendas where name = 'Estética'
union all
select id, 'Consulta', null, 30, true, 1 from agendas where name = 'Depilação a laser';

-- Return periods from Igor; null = default (6 months, in settings).
insert into procedures (name, reminder_months) values
    ('Botox', 4),
    ('Ultraformer', 6),
    ('Preenchimento com ácido hialurônico', 12),
    ('Limpeza de pele', 2),
    ('Depilação a laser', 2),
    ('Laser Spectra (melasma)', 3),
    ('Hidratação', null),
    ('Decapagem', null),
    ('Peeling de cristal', null);

insert into note_shortcuts (label, insert_text, kind, sort_order) values
    ('L', 'Limpeza', 'procedimento', 1),
    ('H', 'Hidratação', 'procedimento', 2),
    ('D', 'Decapagem', 'procedimento', 3),
    ('C', 'Cristal', 'procedimento', 4),
    ('LC1', 'Loção clareadora 1', 'produto', 5),
    ('LC2', 'Loção clareadora 2', 'produto', 6),
    ('Sol', 'Solução de acne', 'produto', 7);

insert into chat_channels (name, everyone, color) values ('Recepção', true, '#E07A7A');
