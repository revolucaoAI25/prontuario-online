-- Hours sent by the clinic on 05/11.
--
-- Estética, Monday to Friday: one-hour slots at 8:30, 9:30, 10:30, 11:30,
-- 13:30, 14:30, 15:30, 16:30 and 17:30; closed only for lunch (12:30–13:30).
-- Saturday is unchanged.
--
-- Simone: afternoons start at 13:30 instead of 14:00 (the slot at 13:30 is
-- added on the days that had 14:00). Other windows are unchanged.
--
-- On a fresh install the agendas do not exist yet (the seed comes after), so
-- this does nothing there.

do $$
declare
    v_estetica uuid := (select id from agendas where name = 'Estética');
    v_simone uuid := (select id from agendas where name = 'Simone Rezeck');
    d integer;
begin
    if v_estetica is not null then
        delete from agenda_hours where agenda_id = v_estetica and weekday between 1 and 5;
        delete from agenda_slot_times where agenda_id = v_estetica and weekday between 1 and 5;
        for d in 1..5 loop
            insert into agenda_hours (agenda_id, weekday, start_time, end_time) values
                (v_estetica, d, '08:30', '12:30'),
                (v_estetica, d, '13:30', '18:30');
            insert into agenda_slot_times (agenda_id, weekday, start_time)
            select v_estetica, d, t::time
            from unnest(array['08:30', '09:30', '10:30', '11:30', '13:30', '14:30', '15:30', '16:30', '17:30']) as t
            on conflict do nothing;
        end loop;
    end if;

    if v_simone is not null then
        insert into agenda_slot_times (agenda_id, weekday, start_time)
        select v_simone, h.weekday, '13:30'
        from agenda_hours h
        where h.agenda_id = v_simone and h.start_time = '14:00'
          and exists (select 1 from agenda_slot_times st where st.agenda_id = v_simone and st.weekday = h.weekday)
        on conflict do nothing;
        update agenda_hours set start_time = '13:30'
        where agenda_id = v_simone and start_time = '14:00'
          and not exists (
              select 1 from agenda_hours o
              where o.agenda_id = agenda_hours.agenda_id and o.weekday = agenda_hours.weekday
                and o.id <> agenda_hours.id and o.end_time > '13:30' and o.start_time < '14:00'
          );
    end if;
end;
$$;
