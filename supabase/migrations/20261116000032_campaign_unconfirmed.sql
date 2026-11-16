-- Disparos: a webhook that takes the message but doesn't answer in time
-- (Chatflux only answers after running its actions) counts as sent, without
-- confirmation, and is never sent again.
create function mark_campaign_unconfirmed(p_recipient_id uuid, p_note text) returns void
language sql security definer set search_path = public as $$
    select mark_campaign_sent(p_recipient_id);
    update campaign_recipients set last_error = left(p_note, 1000) where id = p_recipient_id;
$$;
revoke execute on function mark_campaign_unconfirmed(uuid, text) from public;
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'anon') then
        revoke execute on function mark_campaign_unconfirmed(uuid, text) from anon, authenticated;
    end if;
end;
$$;
