-- Internal team chat ("grupos" per agenda/sector) and the read-only mirror of
-- patients' WhatsApp conversations received from the Evolution API.

create table chat_channels (
    id uuid primary key default gen_random_uuid(),
    name text not null unique,
    agenda_id uuid unique references agendas (id) on delete set null,
    created_at timestamptz not null default now()
);

-- Extra members beyond the defaults (admin and secretaries see every channel;
-- a professional sees the channel of their own agenda).
create table chat_channel_members (
    channel_id uuid not null references chat_channels (id) on delete cascade,
    staff_id uuid not null references staff (id) on delete cascade,
    primary key (channel_id, staff_id)
);

create table chat_messages (
    id uuid primary key default gen_random_uuid(),
    channel_id uuid not null references chat_channels (id) on delete cascade,
    author_id uuid references staff (id) on delete set null,
    body text not null check (btrim(body) <> ''),
    created_at timestamptz not null default now()
);

create index chat_messages_channel_idx on chat_messages (channel_id, created_at desc);

create table chat_reads (
    channel_id uuid not null references chat_channels (id) on delete cascade,
    staff_id uuid not null references staff (id) on delete cascade,
    last_read_at timestamptz not null default now(),
    primary key (channel_id, staff_id)
);

create function can_access_channel(p_channel_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
    select exists (
        select 1
        from staff s
        join chat_channels c on c.id = p_channel_id
        where s.id = auth.uid() and s.active
          and (
              s.role in ('admin', 'secretaria')
              or (c.agenda_id is not null and c.agenda_id = s.agenda_id)
              or exists (select 1 from chat_channel_members m where m.channel_id = c.id and m.staff_id = s.id)
          )
    )
$$;

create function agendas_create_channel() returns trigger
language plpgsql security definer set search_path = public as $$
begin
    insert into chat_channels (name, agenda_id) values (new.name, new.id)
    on conflict (name) do update set agenda_id = excluded.agenda_id;
    return null;
end;
$$;

create trigger agendas_create_channel after insert on agendas
for each row when (new.active) execute function agendas_create_channel();

create function unread_counts() returns table (channel_id uuid, unread bigint)
language sql stable as $$
    select c.id,
           (select count(*) from chat_messages m
            where m.channel_id = c.id
              and m.author_id is distinct from auth.uid()
              and m.created_at > coalesce(
                  (select r.last_read_at from chat_reads r where r.channel_id = c.id and r.staff_id = auth.uid()),
                  '-infinity'::timestamptz))
    from chat_channels c
    where can_access_channel(c.id)
$$;

create table whatsapp_messages (
    id uuid primary key default gen_random_uuid(),
    instance text not null,
    wa_message_id text not null,
    remote_jid text not null,
    phone_digits text,
    patient_id uuid references patients (id) on delete set null,
    from_me boolean not null default false,
    push_name text,
    message_type text,
    body text,
    sent_at timestamptz not null,
    raw jsonb,
    -- staff member who sent it from the system (null: sent from the phone)
    sent_by uuid references staff (id) on delete set null,
    -- delivery of our own messages: pendente → enviado → entregue → lido (or erro)
    status text check (status in ('pendente', 'enviado', 'entregue', 'lido', 'erro')),
    -- photos, videos, audio, documents and stickers are copied into Storage
    -- (bucket "prontuario", folder whatsapp/), since WhatsApp's links expire
    media_kind text check (media_kind in ('imagem', 'video', 'audio', 'documento', 'figurinha')),
    media_status text check (media_status in ('pendente', 'ok', 'erro')),
    media_path text,
    media_mime text,
    media_name text,
    media_size bigint,
    media_error text,
    created_at timestamptz not null default now(),
    unique (instance, wa_message_id)
);

create index whatsapp_messages_jid_idx on whatsapp_messages (remote_jid, sent_at desc);
create index whatsapp_messages_patient_idx on whatsapp_messages (patient_id);

-- Only moves forward: a late "delivered" never undoes "read".
create function whatsapp_status_rank(p_status text) returns integer
language sql immutable parallel safe as $$
    select case p_status
        when 'erro' then 0 when 'pendente' then 1 when 'enviado' then 2
        when 'entregue' then 3 when 'lido' then 4 else -1 end
$$;

-- The WhatsApp inbox is shared: once someone on the team opens a
-- conversation, it is read for everybody.
create table whatsapp_reads (
    remote_jid text primary key,
    read_at timestamptz not null default now(),
    read_by uuid references staff (id) on delete set null
);

create function mark_whatsapp_read(p_remote_jid text) returns void
language sql as $$
    insert into whatsapp_reads (remote_jid, read_at, read_by)
    values (p_remote_jid, now(), auth.uid())
    on conflict (remote_jid) do update set read_at = excluded.read_at, read_by = excluded.read_by
$$;

create function match_patient_by_phone(p_digits text) returns uuid
language sql stable as $$
    select id from patients
    where phone_key(p_digits) is not null
      and (phone_key(phone) = phone_key(p_digits) or phone_key(phone_alt) = phone_key(p_digits))
    order by updated_at desc
    limit 1
$$;

-- The patient link is resolved at read time too, so a conversation that
-- started before the patient was registered still shows their name.
create view whatsapp_conversations with (security_invoker = true) as
select c.*, p.full_name as patient_name
from (
    select distinct on (m.remote_jid)
        m.remote_jid,
        m.phone_digits,
        coalesce(m.patient_id, match_patient_by_phone(m.phone_digits)) as patient_id,
        -- our own messages carry no contact name; use the latest one they sent
        coalesce(m.push_name, (select x.push_name from whatsapp_messages x
                               where x.remote_jid = m.remote_jid and x.push_name is not null
                               order by x.sent_at desc limit 1)) as push_name,
        m.body as last_body,
        m.media_kind as last_media_kind,
        m.from_me as last_from_me,
        m.status as last_status,
        m.sent_at as last_at,
        (select count(*) from whatsapp_messages x where x.remote_jid = m.remote_jid) as message_count,
        (select count(*) from whatsapp_messages x
         where x.remote_jid = m.remote_jid and not x.from_me
           and x.sent_at > coalesce((select r.read_at from whatsapp_reads r where r.remote_jid = m.remote_jid), '-infinity'::timestamptz)
        ) as unread_count
    from whatsapp_messages m
    order by m.remote_jid, m.sent_at desc
) c
left join patients p on p.id = c.patient_id;
