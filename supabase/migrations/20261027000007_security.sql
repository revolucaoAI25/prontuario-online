-- Row level security, authorship defaults, realtime and storage.
-- Everyone on the clinic staff works with patients, agenda, records, payments
-- and stock; configuration and deletions of sensitive data are admin-only.
-- The HTTP API and the cron use the service role, which bypasses RLS.

create function set_created_by() returns trigger
language plpgsql as $$
begin
    new.created_by = coalesce(new.created_by, auth.uid());
    return new;
end;
$$;

create function set_author_id() returns trigger
language plpgsql as $$
begin
    new.author_id = coalesce(new.author_id, auth.uid());
    return new;
end;
$$;

create trigger patients_set_created_by before insert on patients for each row execute function set_created_by();
create trigger appointments_set_created_by before insert on appointments for each row execute function set_created_by();
create trigger agenda_blocks_set_created_by before insert on agenda_blocks for each row execute function set_created_by();
create trigger record_attachments_set_created_by before insert on record_attachments for each row execute function set_created_by();
create trigger payments_set_created_by before insert on payments for each row execute function set_created_by();
create trigger stock_movements_set_created_by before insert on stock_movements for each row execute function set_created_by();
create trigger record_entries_set_author before insert on record_entries for each row execute function set_author_id();
create trigger chat_messages_set_author before insert on chat_messages for each row execute function set_author_id();

-- Staff can read everything; admin manages people.
alter table staff enable row level security;
create policy staff_select on staff for select to authenticated using (is_staff());
create policy staff_admin on staff for all to authenticated using (is_admin()) with check (is_admin());

alter table settings enable row level security;
create policy settings_select on settings for select to authenticated using (is_staff());
create policy settings_admin on settings for all to authenticated using (is_admin()) with check (is_admin());

-- Clinical day-to-day data: any staff member.
alter table patients enable row level security;
create policy patients_select on patients for select to authenticated using (is_staff());
create policy patients_insert on patients for insert to authenticated with check (is_staff());
create policy patients_update on patients for update to authenticated using (is_staff()) with check (is_staff());
create policy patients_delete on patients for delete to authenticated using (is_admin());

alter table record_entries enable row level security;
create policy record_entries_select on record_entries for select to authenticated using (is_staff());
create policy record_entries_insert on record_entries for insert to authenticated with check (is_staff());
create policy record_entries_update on record_entries for update to authenticated
    using (is_admin() or author_id = auth.uid()) with check (is_admin() or author_id = auth.uid());
create policy record_entries_delete on record_entries for delete to authenticated
    using (is_admin() or author_id = auth.uid());

alter table record_attachments enable row level security;
create policy record_attachments_select on record_attachments for select to authenticated using (is_staff());
create policy record_attachments_insert on record_attachments for insert to authenticated with check (is_staff());
create policy record_attachments_delete on record_attachments for delete to authenticated
    using (is_admin() or created_by = auth.uid());

alter table appointments enable row level security;
create policy appointments_select on appointments for select to authenticated using (is_staff());
create policy appointments_insert on appointments for insert to authenticated with check (is_staff());
create policy appointments_update on appointments for update to authenticated using (is_staff()) with check (is_staff());
create policy appointments_delete on appointments for delete to authenticated using (is_admin());

alter table appointment_procedures enable row level security;
create policy appointment_procedures_all on appointment_procedures for all to authenticated
    using (is_staff()) with check (is_staff());

alter table agenda_blocks enable row level security;
create policy agenda_blocks_all on agenda_blocks for all to authenticated using (is_staff()) with check (is_staff());

alter table procedures enable row level security;
create policy procedures_select on procedures for select to authenticated using (is_staff());
create policy procedures_insert on procedures for insert to authenticated with check (is_staff());
create policy procedures_admin on procedures for update to authenticated using (is_admin()) with check (is_admin());
create policy procedures_delete on procedures for delete to authenticated using (is_admin());

alter table reminders enable row level security;
create policy reminders_select on reminders for select to authenticated using (is_staff());
create policy reminders_insert on reminders for insert to authenticated with check (is_staff());
create policy reminders_update on reminders for update to authenticated using (is_staff()) with check (is_staff());
create policy reminders_delete on reminders for delete to authenticated using (is_admin());

alter table reminder_recalc_queue enable row level security;

alter table birthday_messages enable row level security;
create policy birthday_messages_select on birthday_messages for select to authenticated using (is_staff());

alter table payments enable row level security;
create policy payments_select on payments for select to authenticated using (is_staff());
create policy payments_insert on payments for insert to authenticated with check (is_staff());
create policy payments_update on payments for update to authenticated using (is_staff()) with check (is_staff());
create policy payments_delete on payments for delete to authenticated using (is_admin());

alter table stock_products enable row level security;
create policy stock_products_all on stock_products for all to authenticated using (is_staff()) with check (is_staff());

alter table stock_movements enable row level security;
create policy stock_movements_all on stock_movements for all to authenticated using (is_staff()) with check (is_staff());

-- Configuration: read for staff, change for admin.
alter table agendas enable row level security;
create policy agendas_select on agendas for select to authenticated using (is_staff());
create policy agendas_admin on agendas for all to authenticated using (is_admin()) with check (is_admin());

alter table agenda_hours enable row level security;
create policy agenda_hours_select on agenda_hours for select to authenticated using (is_staff());
create policy agenda_hours_admin on agenda_hours for all to authenticated using (is_admin()) with check (is_admin());

alter table agenda_slot_times enable row level security;
create policy agenda_slot_times_select on agenda_slot_times for select to authenticated using (is_staff());
create policy agenda_slot_times_admin on agenda_slot_times for all to authenticated using (is_admin()) with check (is_admin());

alter table appointment_types enable row level security;
create policy appointment_types_select on appointment_types for select to authenticated using (is_staff());
create policy appointment_types_admin on appointment_types for all to authenticated using (is_admin()) with check (is_admin());

alter table note_shortcuts enable row level security;
create policy note_shortcuts_select on note_shortcuts for select to authenticated using (is_staff());
create policy note_shortcuts_admin on note_shortcuts for all to authenticated using (is_admin()) with check (is_admin());

-- Internal chat.
alter table chat_channels enable row level security;
create policy chat_channels_select on chat_channels for select to authenticated using (can_access_channel(id));
create policy chat_channels_admin on chat_channels for all to authenticated using (is_admin()) with check (is_admin());

alter table chat_channel_members enable row level security;
create policy chat_channel_members_select on chat_channel_members for select to authenticated using (is_staff());
create policy chat_channel_members_admin on chat_channel_members for all to authenticated using (is_admin()) with check (is_admin());

alter table chat_messages enable row level security;
create policy chat_messages_select on chat_messages for select to authenticated using (can_access_channel(channel_id));
create policy chat_messages_insert on chat_messages for insert to authenticated
    with check (can_access_channel(channel_id) and author_id = auth.uid());
create policy chat_messages_delete on chat_messages for delete to authenticated using (author_id = auth.uid());

alter table chat_reads enable row level security;
create policy chat_reads_own on chat_reads for all to authenticated
    using (staff_id = auth.uid()) with check (staff_id = auth.uid());

-- WhatsApp mirror: written only by the webhook (service role).
alter table whatsapp_messages enable row level security;
create policy whatsapp_messages_select on whatsapp_messages for select to authenticated using (is_staff());

-- Queue/dispatch internals are for the server only.
revoke execute on function
    claim_due_reminders(integer, integer),
    mark_reminder_sent(uuid),
    mark_reminder_failed(uuid, text),
    claim_birthdays(integer, integer),
    mark_birthday_sent(uuid),
    mark_birthday_failed(uuid, text),
    recompute_reminder(uuid, uuid),
    recompute_patient_reminders(uuid),
    enqueue_reminder_recalc(uuid)
from public;

do $$
begin
    if exists (select 1 from pg_roles where rolname = 'anon') then
        revoke execute on function
            claim_due_reminders(integer, integer), mark_reminder_sent(uuid), mark_reminder_failed(uuid, text),
            claim_birthdays(integer, integer), mark_birthday_sent(uuid), mark_birthday_failed(uuid, text),
            recompute_reminder(uuid, uuid), recompute_patient_reminders(uuid), enqueue_reminder_recalc(uuid)
        from anon, authenticated;
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
        grant execute on function
            claim_due_reminders(integer, integer), mark_reminder_sent(uuid), mark_reminder_failed(uuid, text),
            claim_birthdays(integer, integer), mark_birthday_sent(uuid), mark_birthday_failed(uuid, text),
            recompute_reminder(uuid, uuid), recompute_patient_reminders(uuid)
        to service_role;
    end if;
end;
$$;

-- Live updates for the agenda, the internal chat and the WhatsApp mirror.
do $$
begin
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
        alter publication supabase_realtime add table appointments, chat_messages, whatsapp_messages;
    end if;
end;
$$;

-- Private bucket for record attachments.
do $$
begin
    if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
        insert into storage.buckets (id, name, public) values ('prontuario', 'prontuario', false)
        on conflict (id) do nothing;

        execute $p$
            create policy prontuario_staff_read on storage.objects for select to authenticated
            using (bucket_id = 'prontuario' and public.is_staff())
        $p$;
        execute $p$
            create policy prontuario_staff_write on storage.objects for insert to authenticated
            with check (bucket_id = 'prontuario' and public.is_staff())
        $p$;
        execute $p$
            create policy prontuario_staff_delete on storage.objects for delete to authenticated
            using (bucket_id = 'prontuario' and public.is_staff())
        $p$;
    end if;
end;
$$;
