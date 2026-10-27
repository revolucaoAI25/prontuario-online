-- Team groups the admin creates (for everyone, or for chosen people), and
-- "delete" for procedures and agendas that keeps history intact: one never
-- used is deleted; one with visits behind it is archived (hidden, kept).

alter table chat_channels add column everyone boolean not null default false;
update chat_channels set everyone = true where name = 'Recepção';

create or replace function can_access_channel(p_channel_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
    select exists (
        select 1
        from staff s
        join chat_channels c on c.id = p_channel_id
        where s.id = auth.uid() and s.active
          and (
              s.role in ('admin', 'secretaria')
              or c.everyone
              or (c.agenda_id is not null and c.agenda_id = s.agenda_id)
              or exists (select 1 from chat_channel_members m where m.channel_id = c.id and m.staff_id = s.id)
          )
    )
$$;

alter table procedures add column archived boolean not null default false;

-- Runs as the caller, so the admin-only policies decide who may do it.
create function delete_procedure(p_id uuid) returns text
language plpgsql as $$
begin
    if exists (select 1 from appointment_procedures where procedure_id = p_id) then
        update procedures set active = false, archived = true where id = p_id;
        if not found then raise exception 'acesso_negado'; end if;
        delete from reminders where procedure_id = p_id and status = 'pendente';
        return 'arquivado';
    end if;
    delete from procedures where id = p_id;
    if not found then raise exception 'acesso_negado'; end if;
    return 'apagado';
end;
$$;

create function delete_agenda(p_id uuid) returns text
language plpgsql as $$
begin
    if exists (select 1 from appointments where agenda_id = p_id) then
        update agendas set active = false where id = p_id;
        if not found then raise exception 'acesso_negado'; end if;
        return 'arquivado';
    end if;
    delete from agendas where id = p_id;
    if not found then raise exception 'acesso_negado'; end if;
    return 'apagado';
end;
$$;
