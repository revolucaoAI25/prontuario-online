-- Return reminders per procedure, and birthday messages.
--
-- A patient's pending reminder for a procedure is *derived* from their latest
-- attended ('chegou') appointment that included that procedure:
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
