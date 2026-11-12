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
