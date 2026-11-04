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
