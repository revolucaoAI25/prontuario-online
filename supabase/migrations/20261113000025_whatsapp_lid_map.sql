-- Newer WhatsApp accounts identify a contact by an anonymous "@lid" id
-- instead of the phone. Evolution usually sends the phone along
-- (remoteJidAlt / senderPn); when it does, the pair is remembered, so a
-- later message that only carries the "@lid" id still lands in the same
-- conversation (one per phone) and is linked to the patient.

create table whatsapp_lid_map (
    lid text primary key,
    phone_jid text not null,
    updated_at timestamptz not null default now()
);
alter table whatsapp_lid_map enable row level security;
-- No policies: only the server (webhook, sync) reads and writes it.
