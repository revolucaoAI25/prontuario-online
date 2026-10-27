-- Development logins (password for all: senha123). Local databases only.
insert into auth.users (id, email, encrypted_password) values
    ('00000000-0000-0000-0000-0000000000a1', 'everson@clinica.dev', extensions.crypt('senha123', extensions.gen_salt('bf'))),
    ('00000000-0000-0000-0000-0000000000a2', 'recepcao@clinica.dev', extensions.crypt('senha123', extensions.gen_salt('bf'))),
    ('00000000-0000-0000-0000-0000000000a3', 'simone@clinica.dev', extensions.crypt('senha123', extensions.gen_salt('bf')))
on conflict (id) do nothing;

insert into staff (id, full_name, role, agenda_id) values
    ('00000000-0000-0000-0000-0000000000a1', 'Dr. Everson Rezeck', 'admin', (select id from agendas where name = 'Dr. Everson Rezeck')),
    ('00000000-0000-0000-0000-0000000000a2', 'Ana (Recepção)', 'secretaria', null),
    ('00000000-0000-0000-0000-0000000000a3', 'Simone Rezeck', 'profissional', (select id from agendas where name = 'Simone Rezeck'))
on conflict (id) do nothing;
