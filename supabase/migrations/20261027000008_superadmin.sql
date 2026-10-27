-- Super admin: the agency that set the system up. Everything an admin can do,
-- plus the integrations (reminder/birthday webhooks, the WhatsApp
-- connection). Admins (the clinic) can neither see nor change those, nor edit
-- a super admin's login.

alter table staff add column is_superadmin boolean not null default false;
alter table staff add constraint staff_superadmin_is_admin check (not is_superadmin or role = 'admin');

create function is_superadmin() returns boolean
language sql stable security definer set search_path = public as $$
    select coalesce((select s.is_superadmin from staff s where s.id = auth.uid() and s.active and s.role = 'admin'), false)
$$;

-- Settings only the super admin sees and edits.
alter table settings add column superadmin_only boolean not null default false;
update settings set superadmin_only = true where key in ('reminder_webhook_url', 'birthday_webhook_url');

drop policy settings_select on settings;
drop policy settings_admin on settings;
create policy settings_select on settings for select to authenticated
    using ((select is_staff()) and (not superadmin_only or (select is_superadmin())));
create policy settings_admin on settings for all to authenticated
    using ((select is_admin()) and (not superadmin_only or (select is_superadmin())))
    with check ((select is_admin()) and (not superadmin_only or (select is_superadmin())));

-- Admins manage the team, except super admins.
drop policy staff_admin on staff;
create policy staff_admin on staff for all to authenticated
    using ((select is_admin()) and (not is_superadmin or (select is_superadmin())))
    with check ((select is_admin()) and (not is_superadmin or (select is_superadmin())));
