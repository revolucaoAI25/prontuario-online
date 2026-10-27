-- Fictitious data for local development and screenshots: patients, three
-- weeks of agenda around today, records, payments, stock, team chat and
-- WhatsApp conversations. Never run against the clinic's database.
--
--   psql -d prontuario -f dev/seed-users.sql -f dev/demo-data.sql

select setseed(0.42);

-- Patients ------------------------------------------------------------------
insert into patients (full_name, phone, email, birth_date, profession)
select f || ' ' || s1 || ' ' || s2,
       format('(31) 9%s-%s', 8000 + (random() * 1999)::int, 1000 + (random() * 8999)::int),
       case when random() < 0.6 then normalize_text(f) || '.' || normalize_text(s2) || '@email.com' end,
       (date '1960-01-01' + (random() * 15000)::int),
       (array['Advogada', 'Professora', 'Empresária', 'Arquiteta', 'Dentista', 'Engenheira', 'Designer', 'Médica', null])[1 + (random() * 8)::int]
from unnest(array['Ana', 'Beatriz', 'Camila', 'Daniela', 'Eduarda', 'Fernanda', 'Gabriela', 'Helena', 'Isabela', 'Juliana',
                  'Larissa', 'Mariana', 'Natália', 'Patrícia', 'Renata', 'Sofia', 'Tatiane', 'Vanessa', 'Carlos', 'Rafael']) f
cross join lateral (
    select (array['Almeida', 'Barbosa', 'Cardoso', 'Duarte', 'Ferreira', 'Gomes', 'Lima', 'Martins', 'Nogueira', 'Oliveira', 'Pereira', 'Ribeiro', 'Santos', 'Teixeira'])[1 + (random() * 13)::int] s1,
           (array['Andrade', 'Bastos', 'Campos', 'Diniz', 'Fonseca', 'Guimarães', 'Lacerda', 'Moreira', 'Rezende', 'Siqueira', 'Vasconcelos'])[1 + (random() * 10)::int] s2
    from generate_series(1, 3)
) n;

-- Agenda: three weeks around today -----------------------------------------
create temp table demo_slots as
with days as (
    select d::date as day from generate_series(clinic_today() - 14, clinic_today() + 21, interval '1 day') d
    where extract(dow from d) between 1 and 5
),
agenda_types as (
    select a.id as agenda_id, a.name, t.id as type_id, t.duration_minutes as dur
    from agendas a join appointment_types t on t.agenda_id = a.id and t.is_default
)
select at.agenda_id, at.name, at.type_id, d.day, m as start_min, at.dur
from days d cross join agenda_types at
cross join lateral generate_series(8 * 60, 18 * 60 - at.dur, at.dur) m
where random() + (m * 0) < case at.name when 'Estética' then 0.7 when 'Depilação a laser' then 0.5 else 0.6 end
  and m not between 12 * 60 and 13 * 60 - 1;

insert into appointments (agenda_id, appointment_type_id, patient_id, starts_at, ends_at, status, notes)
select s.agenda_id, s.type_id,
       (select id from patients order by random() + (s.start_min * 0) limit 1),
       local_timestamp(s.day, make_time(s.start_min / 60, s.start_min % 60, 0)),
       local_timestamp(s.day, make_time((s.start_min + s.dur) / 60, (s.start_min + s.dur) % 60, 0)),
       (case
           when local_timestamp(s.day, make_time(s.start_min / 60, s.start_min % 60, 0)) < now() then
               case when r < 0.84 then 'chegou' when r < 0.94 then 'nao_compareceu' else 'cancelado' end
           else case when r < 0.45 then 'agendado' when r < 0.9 then 'confirmado' else 'pediu_remarcar' end
       end)::appointment_status,
       case when random() < 0.12 then (array['Primeira vez na clínica', 'Prefere horários pela manhã', 'Veio por indicação', 'Trazer exames'])[1 + (random() * 3)::int] end
from (select *, random() as r from demo_slots) s;

insert into appointment_procedures (appointment_id, procedure_id)
select distinct a.id, p.id
from appointments a
join agendas ag on ag.id = a.agenda_id
cross join lateral (
    select pr.id from procedures pr
    where pr.name = any (case ag.name
        when 'Dr. Everson Rezeck' then array['Botox', 'Preenchimento com ácido hialurônico', 'Ultraformer', 'Laser Spectra (melasma)']
        when 'Simone Rezeck' then array['Botox', 'Limpeza de pele', 'Peeling de cristal']
        when 'Estética' then array['Limpeza de pele', 'Hidratação', 'Decapagem', 'Peeling de cristal']
        else array['Depilação a laser'] end)
    order by random() + (extract(epoch from a.starts_at) * 0)
    limit case when ag.name = 'Depilação a laser' then 1 else (random() * 2)::int end
) p;

-- A lunch block today and a holiday-style block next week.
insert into agenda_blocks (agenda_id, starts_at, ends_at, reason)
select id, local_timestamp(clinic_today(), '12:00'), local_timestamp(clinic_today(), '13:00'), 'Almoço'
from agendas where name = 'Dr. Everson Rezeck';

-- Records ------------------------------------------------------------------
insert into record_entries (patient_id, entry_at, content)
select a.patient_id, a.ends_at,
       (array[
           'Paciente refere boa evolução desde a última sessão. Pele hidratada, sem eritema.',
           'L + H. Orientada a usar protetor solar FPS 50 diariamente.',
           'Aplicação de toxina botulínica em glabela e frontal. Retorno em 15 dias para avaliação.',
           'D + C. Leve sensibilidade na região malar, orientada sobre cuidados em casa. LC1 à noite.',
           'Avaliação estética: melasma em região malar bilateral. Indicado Laser Spectra, 4 sessões.',
           'Sessão de depilação a laser em axilas e virilha. Sem intercorrências.'
       ])[1 + (random() * 5)::int]
from appointments a where a.status = 'chegou' and random() < 0.7;

-- Payments -----------------------------------------------------------------
insert into payments (patient_id, appointment_id, amount, method, installments, status, occurred_on, description)
select a.patient_id, a.id,
       (array[180, 250, 350, 450, 900, 1200, 1800])[1 + (random() * 6)::int],
       (array['pix', 'cartao_credito', 'cartao_debito', 'dinheiro'])[1 + (random() * 3)::int]::payment_method,
       1, case when random() < 0.9 then 'pago' else 'pendente' end::payment_status,
       (a.starts_at at time zone 'America/Sao_Paulo')::date,
       (select string_agg(p.name, ', ') from appointment_procedures ap join procedures p on p.id = ap.procedure_id where ap.appointment_id = a.id)
from appointments a where a.status = 'chegou' and random() < 0.8;

-- Stock --------------------------------------------------------------------
insert into stock_products (name, unit, location, min_quantity) values
    ('Toxina botulínica 100U', 'frasco', 'Geladeira', 4),
    ('Ácido hialurônico 1ml', 'seringa', 'Armário 2', 6),
    ('Loção clareadora 1', 'frasco', 'Estética', 3),
    ('Solução de acne', 'frasco', 'Estética', 3),
    ('Máscara hidratante', 'un', 'Estética', 10),
    ('Gel condutor', 'litro', 'Depilação', 2),
    ('Luvas de procedimento M', 'caixa', 'Almoxarifado', 5);
insert into stock_movements (product_id, type, quantity, moved_at, note)
select id, 'entrada', (min_quantity * (2 + random() * 3))::int, now() - interval '20 days', 'Compra mensal' from stock_products;
insert into stock_movements (product_id, type, quantity, moved_at)
select id, 'saida', greatest(1, (min_quantity * random() * 3)::int), now() - (random() * 15)::int * interval '1 day' from stock_products;

-- Team chat ----------------------------------------------------------------
insert into chat_messages (channel_id, author_id, body, created_at)
select c.id, m.author::uuid, m.body, now() - m.ago
from chat_channels c
cross join (values
    ('00000000-0000-0000-0000-0000000000a2', 'Bom dia! A paciente das 10h ligou avisando que vai atrasar uns 15 minutos.', interval '3 hours'),
    ('00000000-0000-0000-0000-0000000000a1', 'Sem problema, pode encaixar a avaliação das 10h20 antes.', interval '2 hours 55 minutes'),
    ('00000000-0000-0000-0000-0000000000a3', 'Chegou o pedido de máscaras hidratantes, já guardei no armário da estética.', interval '1 hour'),
    ('00000000-0000-0000-0000-0000000000a2', 'Obrigada! Já dei entrada no estoque.', interval '50 minutes')
) m(author, body, ago)
where c.name = 'Recepção';

-- WhatsApp -----------------------------------------------------------------
insert into whatsapp_messages (instance, wa_message_id, remote_jid, phone_digits, from_me, push_name, body, sent_at, status)
select 'demo', 'DEMO' || row_number() over (), '55' || only_digits(p.phone) || '@s.whatsapp.net', '55' || only_digits(p.phone),
       m.from_me, case when not m.from_me then split_part(p.full_name, ' ', 1) end, m.body, now() - m.ago,
       case when m.from_me then 'lido' end
from (select * from patients order by full_name limit 6) p
cross join lateral (values
    (false, 'Olá, boa tarde! Gostaria de saber se tem horário para limpeza de pele na próxima semana.', interval '5 hours' + (random() * 40)::int * interval '1 hour'),
    (true, 'Olá! Temos sim. Quinta-feira às 14h ou sexta às 9h30, qual fica melhor?', interval '4 hours 50 minutes' + (random() * 40)::int * interval '1 hour'),
    (false, 'Quinta às 14h, por favor 😊', interval '4 hours 30 minutes' + (random() * 40)::int * interval '1 hour')
) m(from_me, body, ago);

drop table demo_slots;
