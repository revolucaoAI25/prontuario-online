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
        select a.id, a.name, a.color, a.sort_order from agendas a where a.active and finance_visible(a.id)
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
