-- The WhatsApp conversation list took over two minutes for a logged-in user
-- (and so came back empty: the app gives up after 8 seconds). Each
-- conversation looks its patient up by phone; under the patients' access
-- rules the database may not use the phone index for that (phone_key is not
-- "leakproof"), so it read all patients once per conversation. The lookup
-- now runs with the owner's rights, which uses the index; it only returns
-- an id, and the patient's name still comes through the normal rules.
create or replace function match_patient_by_phone(p_digits text) returns uuid
language sql stable security definer set search_path = public as $$
    select id from patients
    where phone_key(p_digits) is not null
      and (phone_key(phone) = phone_key(p_digits) or phone_key(phone_alt) = phone_key(p_digits))
    order by updated_at desc
    limit 1
$$;
revoke execute on function match_patient_by_phone(text) from anon;

-- Messages already linked at arrival don't need the lookup at all; link the
-- ones that arrived before their patient was registered.
update whatsapp_messages m
set patient_id = match_patient_by_phone(m.phone_digits)
where m.patient_id is null and m.phone_digits is not null and match_patient_by_phone(m.phone_digits) is not null;
