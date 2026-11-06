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
