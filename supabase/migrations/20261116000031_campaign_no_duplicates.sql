-- Disparos: when a campaign webhook doesn't answer in time, the message may
-- still have been received; trying again could message the patient twice.
-- Such a failure is final ('erro', to check by hand); other failures (an
-- error answer, an unreachable address) still try again 3 times.
drop function mark_campaign_failed(uuid, text);
create function mark_campaign_failed(p_recipient_id uuid, p_error text, p_final boolean default false) returns void
language sql security definer set search_path = public as $$
    update campaign_recipients
    set last_error = left(p_error, 1000),
        status = case when p_final or attempts >= 3 then 'erro' else 'pendente' end,
        locked_until = case when p_final or attempts >= 3 then null else now() + interval '5 minutes' end
    where id = p_recipient_id;
$$;
revoke execute on function mark_campaign_failed(uuid, text, boolean) from public;
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'anon') then
        revoke execute on function mark_campaign_failed(uuid, text, boolean) from anon, authenticated;
    end if;
end;
$$;
