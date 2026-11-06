-- Recurring blocks: a block that repeats is stored as one row per day, all
-- with the same series_id, so availability (and the WhatsApp agent) needs no
-- change and one day can still be unblocked on its own.
alter table agenda_blocks add column series_id uuid;
create index agenda_blocks_series_idx on agenda_blocks (series_id) where series_id is not null;
