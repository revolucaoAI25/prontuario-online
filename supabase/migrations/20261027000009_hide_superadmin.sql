-- The support login is invisible to the clinic: only another super admin
-- sees it (in Ajustes → Usuários, chat author names, etc.).

drop policy staff_select on staff;
create policy staff_select on staff for select to authenticated
    using ((select is_staff()) and (not is_superadmin or (select is_superadmin()) or id = (select auth.uid())));
