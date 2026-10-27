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
language sql stable as $$ select (now() at time zone clinic_tz())::date $$;

create function normalize_text(t text) returns text
language sql immutable parallel safe as $$
    select lower(extensions.unaccent('extensions.unaccent'::regdictionary, coalesce(t, '')))
$$;

create function only_digits(t text) returns text
language sql immutable parallel safe as $$ select regexp_replace(coalesce(t, ''), '\D', '', 'g') $$;

-- Brazilian phone key: DDD + last 8 digits. Ignores the country code and the
-- optional 9th mobile digit, which WhatsApp JIDs and typed numbers disagree on.
create function phone_key(digits text) returns text
language sql immutable parallel safe as $$
    select case
        when length(d) >= 10 then left(d, 2) || right(d, 8)
        else null
    end
    from (
        select case
            when length(only_digits(digits)) >= 12 and left(only_digits(digits), 2) = '55'
                then substr(only_digits(digits), 3)
            else ltrim(only_digits(digits), '0')
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
