-- Disparos: the last visit can also be picked as a date range on the
-- calendar (e.g. "last came between March and April", or "from March to
-- today"): filters ultima_visita_de / ultima_visita_ate, both inclusive and
-- each optional.
create or replace function campaign_audience(p_filters jsonb default '{}', p_limit integer default null, p_offset integer default 0)
returns table (patient_id uuid, full_name text, phone text, last_visit date, visits integer, total bigint)
language sql stable security definer set search_path = public as $$
    with f as (
        select
            coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(p_filters -> 'agendas') x), '{}') as agendas,
            coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(p_filters -> 'procedimentos') x), '{}') as procedures,
            nullif(p_filters ->> 'veio_nos_ultimos_meses', '')::integer as within_months,
            nullif(p_filters ->> 'sem_vir_ha_meses', '')::integer as lapsed_months,
            nullif(p_filters ->> 'ultima_visita_de', '')::date as last_from,
            nullif(p_filters ->> 'ultima_visita_ate', '')::date as last_to,
            nullif(p_filters ->> 'aniversario_mes', '')::integer as birth_month,
            nullif(p_filters ->> 'idade_min', '')::integer as age_min,
            nullif(p_filters ->> 'idade_max', '')::integer as age_max,
            coalesce((p_filters ->> 'sem_agendamento_futuro')::boolean, false) as nothing_ahead,
            nullif(btrim(p_filters ->> 'busca'), '') as search
    ),
    base as (
        select p.id, p.full_name, p.phone, p.birth_date,
               v.last_visit, coalesce(v.visits, 0) as visits
        from patients p
        cross join f
        left join lateral (
            select max((a.starts_at at time zone clinic_tz())::date) as last_visit, count(*)::integer as visits
            from appointments a where a.patient_id = p.id and a.status = 'chegou'
        ) v on true
        where is_superadmin()
          and p.allow_messages and p.phone_digits <> ''
          and (cardinality(f.agendas) = 0 or exists (
              select 1 from appointments a where a.patient_id = p.id and a.status = 'chegou' and a.agenda_id = any (f.agendas)))
          and (cardinality(f.procedures) = 0 or exists (
              select 1 from appointments a join appointment_procedures ap on ap.appointment_id = a.id
              where a.patient_id = p.id and a.status = 'chegou' and ap.procedure_id = any (f.procedures)))
          and (f.within_months is null or v.last_visit >= (clinic_today() - make_interval(months => f.within_months))::date)
          and (f.lapsed_months is null or v.last_visit < (clinic_today() - make_interval(months => f.lapsed_months))::date)
          and (f.last_from is null or v.last_visit >= f.last_from)
          and (f.last_to is null or v.last_visit <= f.last_to)
          and (f.birth_month is null or extract(month from p.birth_date) = f.birth_month)
          and (f.age_min is null or p.birth_date <= (clinic_today() - make_interval(years => f.age_min))::date)
          and (f.age_max is null or p.birth_date > (clinic_today() - make_interval(years => f.age_max + 1))::date)
          and (not f.nothing_ahead or not exists (
              select 1 from appointments a where a.patient_id = p.id and a.starts_at > now()
                and a.removed_at is null and a.status in ('agendado', 'confirmado')))
          and (f.search is null or normalize_text(p.full_name) like '%' || normalize_text(f.search) || '%'
               or (regexp_replace(f.search, '\D', '', 'g') <> '' and p.phone_digits like '%' || regexp_replace(f.search, '\D', '', 'g') || '%'))
    )
    select b.id, b.full_name, b.phone, b.last_visit, b.visits, count(*) over () as total
    from base b
    order by b.full_name, b.id
    limit p_limit offset p_offset
$$;
