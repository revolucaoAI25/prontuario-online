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

-- Closed periods: a whole day off, a holiday (agenda_id null = whole clinic),
-- or a few hours blocked.
create table agenda_blocks (
    id uuid primary key default gen_random_uuid(),
    agenda_id uuid references agendas (id) on delete cascade,
    starts_at timestamptz not null,
    ends_at timestamptz not null,
    reason text,
    created_by uuid references staff (id) on delete set null,
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
    candidates as (
        select ag.id, ag.name, ag.sort_order, ag.type_id, s.slot_start,
               s.slot_start + make_interval(mins => ag.duration) as slot_end
        from ag
        join agenda_hours h on h.agenda_id = ag.id and h.weekday = extract(dow from p_date)
        cross join lateral generate_series(
            local_timestamp(p_date, h.start_time),
            local_timestamp(p_date, h.end_time) - make_interval(mins => ag.duration),
            make_interval(mins => ag.slot_step_minutes)
        ) as s(slot_start)
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

    v_ends_at := coalesce(p_ends_at, p_starts_at + make_interval(mins => coalesce(v_type.duration_minutes, 30)));
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

    v_ends_at := coalesce(p_new_ends_at, p_new_starts_at + (v_appointment.ends_at - v_appointment.starts_at));
    if v_ends_at <= p_new_starts_at then
        raise exception 'horario_invalido';
    end if;

    v_type_id := v_appointment.appointment_type_id;
    if v_agenda_id <> v_appointment.agenda_id then
        select id into v_type_id from appointment_types where agenda_id = v_agenda_id and is_default and active;
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
