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
