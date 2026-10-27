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
