-- Prontuário: anyone on the team can correct an entry (text and date) and
-- its attachments, including the ones imported from FastClinic, which have
-- no author. Every change is kept: who changed it, when, and what it said
-- before. Deleting an entry stays with its author and the administrator.

alter table record_entries add column edited_at timestamptz;
alter table record_entries add column edited_by uuid references staff (id) on delete set null;

create table record_entry_revisions (
    id bigint generated always as identity primary key,
    entry_id uuid not null references record_entries (id) on delete cascade,
    content text not null,
    entry_at timestamptz not null,
    -- who wrote this version (the author, or whoever edited it last)
    written_by uuid references staff (id) on delete set null,
    written_at timestamptz,
    replaced_by uuid references staff (id) on delete set null,
    replaced_at timestamptz not null default now()
);
create index record_entry_revisions_entry_idx on record_entry_revisions (entry_id, replaced_at desc);

alter table record_entry_revisions enable row level security;
create policy record_entry_revisions_select on record_entry_revisions for select to authenticated using ((select is_staff()));

-- Edits made in the app (a logged-in user) are recorded; the FastClinic
-- re-import (no user) only refreshes the text, as before.
create function record_entries_keep_revision() returns trigger
language plpgsql security definer set search_path = public as $$
begin
    if auth.uid() is null then
        return new;
    end if;
    if new.content is distinct from old.content or new.entry_at is distinct from old.entry_at then
        insert into record_entry_revisions (entry_id, content, entry_at, written_by, written_at, replaced_by)
        values (old.id, old.content, old.entry_at, coalesce(old.edited_by, old.author_id), coalesce(old.edited_at, old.created_at), auth.uid());
        new.edited_at := now();
        new.edited_by := auth.uid();
    end if;
    -- the authorship of the entry never changes
    new.author_id := old.author_id;
    return new;
end;
$$;

create trigger record_entries_keep_revision before update on record_entries
for each row execute function record_entries_keep_revision();

drop policy record_entries_update on record_entries;
create policy record_entries_update on record_entries for update to authenticated
    using ((select is_staff())) with check ((select is_staff()));

drop policy record_attachments_delete on record_attachments;
create policy record_attachments_delete on record_attachments for delete to authenticated
    using ((select is_staff()));
