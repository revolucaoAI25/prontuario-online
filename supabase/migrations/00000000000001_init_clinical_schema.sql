-- Clinical core schema migrated from the legacy FastClinic (SQL Server) backup.
-- Source tables: Pessoas, PRONTUARIOS, PRONTUARIOS_EVOLUCAO, ATENDIMENTOS.
-- Every table keeps `legacy_id` (the source SEQ) as a unique key so the ETL
-- script can re-run safely (upsert) for the final cutover sync, and `raw`
-- preserves the full original row as a safety net for fields not promoted
-- to first-class columns (the legacy schema has ~150 columns per evolution,
-- most unused by this clinic).

create extension if not exists pgcrypto;

create table patients (
    id uuid primary key default gen_random_uuid(),
    legacy_id integer not null unique,
    legacy_code text,
    full_name text not null,
    cpf text,
    birth_date date,
    sex text,
    phone text,
    mobile_phone text,
    email text,
    address_street text,
    address_number text,
    address_neighborhood text,
    address_complement text,
    address_city text,
    address_state text,
    address_zip text,
    registered_at timestamptz,
    legacy_updated_at timestamptz,
    raw jsonb not null,
    created_at timestamptz not null default now()
);

create index patients_cpf_idx on patients (cpf);
create index patients_full_name_idx on patients using gin (to_tsvector('portuguese', full_name));

create table appointments (
    id uuid primary key default gen_random_uuid(),
    legacy_id integer not null unique,
    patient_id uuid references patients (id),
    scheduled_at timestamptz,
    confirmed boolean,
    attended boolean,
    cancelled boolean,
    cancel_reason text,
    observation text,
    responsible text,
    legacy_updated_at timestamptz,
    raw jsonb not null,
    created_at timestamptz not null default now()
);

create index appointments_patient_id_idx on appointments (patient_id);
create index appointments_scheduled_at_idx on appointments (scheduled_at);

create table medical_records (
    id uuid primary key default gen_random_uuid(),
    legacy_id integer not null unique,
    patient_id uuid not null references patients (id),
    treatment text,
    death_flag boolean,
    death_date date,
    death_cause text,
    hospitalization_flag boolean,
    hospitalization_date date,
    discharge_date date,
    legacy_updated_at timestamptz,
    raw jsonb not null,
    created_at timestamptz not null default now()
);

create index medical_records_patient_id_idx on medical_records (patient_id);

create table clinical_notes (
    id uuid primary key default gen_random_uuid(),
    legacy_id integer not null unique,
    medical_record_id uuid not null references medical_records (id),
    appointment_id uuid references appointments (id),
    note_at timestamptz,
    chief_complaint text,
    history text,
    anamnesis text,
    physical_exam text,
    conduct text,
    medications text,
    other_notes text,
    allergy text,
    weight_kg numeric,
    height_cm numeric,
    blood_pressure text,
    heart_rate text,
    respiratory_rate text,
    temperature text,
    cancelled boolean,
    legacy_updated_at timestamptz,
    raw jsonb not null,
    created_at timestamptz not null default now()
);

create index clinical_notes_medical_record_id_idx on clinical_notes (medical_record_id);
create index clinical_notes_appointment_id_idx on clinical_notes (appointment_id);
create index clinical_notes_note_at_idx on clinical_notes (note_at);
create index clinical_notes_history_idx on clinical_notes using gin (to_tsvector('portuguese', coalesce(history, '') || ' ' || coalesce(other_notes, '')));
