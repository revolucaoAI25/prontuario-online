-- Starting configuration for the Clínica Dr. Everson Rezeck.
-- Opening hours are a placeholder (Mon–Fri 08:00–18:00) to be adjusted in
-- Configurações.

-- The reception sees the takings of Estética and Depilação (commissions),
-- not those of the two doctors.
insert into agendas (name, color, slot_step_minutes, sort_order, finance_shared) values
    ('Dr. Everson Rezeck', '#0F5C66', 20, 1, false),
    ('Simone Rezeck', '#7A5C99', 20, 2, false),
    ('Estética', '#B07A4F', 30, 3, true),
    ('Depilação a laser', '#4F7FA8', 30, 4, true);

insert into agenda_hours (agenda_id, weekday, start_time, end_time)
select a.id, d.weekday, '08:00', '18:00'
from agendas a cross join generate_series(1, 5) as d(weekday);

insert into appointment_types (agenda_id, name, duration_minutes, is_default, sort_order)
select id, 'Consulta', 40, true, 1 from agendas where name = 'Dr. Everson Rezeck'
union all
select id, 'Avaliação estética', 20, false, 2 from agendas where name = 'Dr. Everson Rezeck'
union all
select id, 'Consulta', 40, true, 1 from agendas where name = 'Simone Rezeck'
union all
select id, 'Consulta', 60, true, 1 from agendas where name = 'Estética'
union all
select id, 'Consulta', 30, true, 1 from agendas where name = 'Depilação a laser';

-- Return periods from Igor; null = default (6 months, in settings).
insert into procedures (name, reminder_months) values
    ('Botox', 4),
    ('Ultraformer', 6),
    ('Preenchimento com ácido hialurônico', 12),
    ('Limpeza de pele', 2),
    ('Depilação a laser', 2),
    ('Laser Spectra (melasma)', 3),
    ('Hidratação', null),
    ('Decapagem', null),
    ('Peeling de cristal', null);

insert into note_shortcuts (label, insert_text, kind, sort_order) values
    ('L', 'Limpeza', 'procedimento', 1),
    ('H', 'Hidratação', 'procedimento', 2),
    ('D', 'Decapagem', 'procedimento', 3),
    ('C', 'Cristal', 'procedimento', 4),
    ('LC1', 'Loção clareadora 1', 'produto', 5),
    ('LC2', 'Loção clareadora 2', 'produto', 6),
    ('Sol', 'Solução de acne', 'produto', 7);

insert into chat_channels (name, everyone) values ('Recepção', true);
