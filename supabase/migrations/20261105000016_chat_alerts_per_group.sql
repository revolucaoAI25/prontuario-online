-- Team chat alerts per group: each person chooses which groups beep, pop a
-- notification and count on the menu bubble. Messages of a silenced group
-- still show (with their unread count) in the Equipe list. The global switch
-- (mute_chat) keeps silencing all of them.
alter table staff add column chat_muted_channels uuid[] not null default '{}';

create function set_my_muted_channels(p_channels uuid[]) returns void
language sql security definer set search_path = public as $$
    update staff
    set chat_muted_channels = coalesce(
        (select array_agg(distinct c) from unnest(p_channels) c where exists (select 1 from chat_channels ch where ch.id = c)),
        '{}')
    where id = auth.uid()
$$;

-- Start sensibly: someone with an agenda of their own (Dr. Everson, for
-- example) is no longer alerted by the groups of the other agendas. The
-- groups for everyone (Recepção) and the ones without an agenda keep alerting.
update staff s
set chat_muted_channels = coalesce(
    (select array_agg(c.id) from chat_channels c where c.agenda_id is not null and c.agenda_id <> s.agenda_id),
    '{}')
where s.agenda_id is not null;
