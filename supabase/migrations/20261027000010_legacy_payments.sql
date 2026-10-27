-- Charges recorded in FastClinic (its PRODUTOS_ESTOQUE table: what each
-- visit was billed) come in as payments, keyed for re-imports.

alter table payments add column legacy_id integer unique;
alter table payments add column legacy_synced_at timestamptz;
