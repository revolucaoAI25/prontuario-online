-- Patients and the medical record ("prontuário"): a dated notepad per patient.

create table patients (
    id uuid primary key default gen_random_uuid(),
    full_name text not null check (btrim(full_name) <> ''),
    cpf text,
    email text,
    phone text,
    phone_alt text,
    phone_digits text generated always as (only_digits(phone)) stored,
    profession text,
    birth_date date,
    address text,
    notes text,
    -- LGPD opt-out / deceased: never send reminders or birthday messages.
    allow_messages boolean not null default true,
    legacy_id integer unique,
    legacy_raw jsonb,
    -- last time the FastClinic import wrote this row; a re-import skips rows
    -- edited in the new system after that
    legacy_synced_at timestamptz,
    created_by uuid references staff (id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index patients_name_trgm_idx on patients using gin (normalize_text(full_name) extensions.gin_trgm_ops);
create index patients_phone_key_idx on patients (phone_key(phone));
create index patients_phone_alt_key_idx on patients (phone_key(phone_alt));
create index patients_cpf_idx on patients (only_digits(cpf));
create index patients_birthday_idx on patients (extract(month from birth_date), extract(day from birth_date));

create trigger patients_set_updated_at before update on patients
for each row execute function set_updated_at();

create table record_entries (
    id uuid primary key default gen_random_uuid(),
    patient_id uuid not null references patients (id) on delete cascade,
    entry_at timestamptz not null default now(),
    content text not null check (btrim(content) <> ''),
    author_id uuid references staff (id) on delete set null,
    appointment_id uuid,
    legacy_id integer unique,
    legacy_synced_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index record_entries_patient_idx on record_entries (patient_id, entry_at desc);
create index record_entries_content_trgm_idx on record_entries using gin (normalize_text(content) extensions.gin_trgm_ops);

create trigger record_entries_set_updated_at before update on record_entries
for each row execute function set_updated_at();

create table record_attachments (
    id uuid primary key default gen_random_uuid(),
    entry_id uuid not null references record_entries (id) on delete cascade,
    patient_id uuid not null references patients (id) on delete cascade,
    storage_path text not null unique,
    file_name text not null,
    mime_type text,
    size_bytes bigint,
    created_by uuid references staff (id) on delete set null,
    created_at timestamptz not null default now()
);

create index record_attachments_entry_idx on record_attachments (entry_id);

-- Letter buttons in the record composer (L = Limpeza, LC1 = Loção clareadora 1, ...).
create table note_shortcuts (
    id uuid primary key default gen_random_uuid(),
    label text not null unique,
    insert_text text not null,
    kind text not null default 'procedimento' check (kind in ('procedimento', 'produto')),
    sort_order integer not null default 0,
    active boolean not null default true
);

-- Name / phone / CPF search used by the patients list, the agenda and the
-- record screen. When p_include_records is true it also matches text inside
-- the patient's record entries.
create function search_patients(p_query text, p_limit integer default 30, p_include_records boolean default false)
returns setof patients
language sql stable as $$
    with q as (
        select normalize_text(btrim(p_query)) as text, only_digits(p_query) as digits
    )
    select p.*
    from patients p, q
    where q.text <> ''
      and (
        normalize_text(p.full_name) like '%' || q.text || '%'
        or (length(q.digits) >= 4 and (
            p.phone_digits like '%' || q.digits || '%'
            or only_digits(p.phone_alt) like '%' || q.digits || '%'
            or only_digits(p.cpf) like '%' || q.digits || '%'
        ))
        or (p_include_records and exists (
            select 1 from record_entries r
            where r.patient_id = p.id and normalize_text(r.content) like '%' || q.text || '%'
        ))
      )
    order by
        (normalize_text(p.full_name) like q.text || '%') desc,
        p.full_name
    limit p_limit
$$;
