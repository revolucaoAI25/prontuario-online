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
drop view if exists public.stock_levels, public.whatsapp_conversations cascade;
drop table if exists public.agenda_blocks, public.agenda_hours, public.agenda_slot_times, public.agendas, public.appointment_procedures, public.appointment_types, public.appointments, public.birthday_messages, public.chat_channel_members, public.chat_channels, public.chat_messages, public.chat_reads, public.note_shortcuts, public.patients, public.payments, public.procedures, public.record_attachments, public.record_entries, public.reminder_recalc_queue, public.reminders, public.settings, public.staff, public.stock_movements, public.stock_products, public.whatsapp_messages, public.whatsapp_reads cascade;
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
-- supabase/seed.sql
-- ---------------------------------------------------------------------

-- Starting configuration for the Clínica Dr. Everson Rezeck.
-- Opening hours are a placeholder (Mon–Fri 08:00–18:00) to be adjusted in
-- Configurações.

insert into agendas (name, color, slot_step_minutes, sort_order) values
    ('Dr. Everson Rezeck', '#0F5C66', 20, 1),
    ('Simone Rezeck', '#7A5C99', 20, 2),
    ('Estética', '#B07A4F', 30, 3),
    ('Depilação a laser', '#4F7FA8', 30, 4);

insert into agenda_hours (agenda_id, weekday, start_time, end_time)
select a.id, d.weekday, '08:00', '18:00'
from agendas a cross join generate_series(1, 5) as d(weekday);

insert into appointment_types (agenda_id, name, duration_minutes, is_default, sort_order)
select id, 'Consulta', 40, true, 1 from agendas where name = 'Dr. Everson Rezeck'
union all
select id, 'Avaliação estética', 20, false, 2 from agendas where name = 'Dr. Everson Rezeck'
union all
select id, 'Consulta', 40, true, 1 from agendas where name = 'Simone Rezeck'
union all
select id, 'Consulta', 60, true, 1 from agendas where name = 'Estética'
union all
select id, 'Consulta', 30, true, 1 from agendas where name = 'Depilação a laser';

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

insert into chat_channels (name) values ('Recepção');
