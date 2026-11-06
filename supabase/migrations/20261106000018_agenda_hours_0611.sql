-- Hours sent by Dr. Everson on 06/11 (they win over the ones of 05/11):
--
--   afternoons start at 13:30 in every agenda, Monday to Friday;
--   mornings start at 8:30 and open only on:
--     Dr. Everson and Simone ...... Wednesday and Saturday
--     Depilação ................... Wednesday, Friday and Saturday
--     Estética .................... Tuesday, Wednesday and Saturday
--
-- Closing times stay as they were. Where an agenda works with fixed start
-- times, the times outside the new windows go away and the new half hours
-- (8:30, 13:00-15:00 gaps) are added on its 30-minute rhythm. Bookings
-- already made are not touched. On a fresh install (no agendas yet) this does
-- nothing.

do $$
declare
    r record;
    v_agenda uuid;
    v_morning_days integer[];
    v_first time;
    d integer;
begin
    for r in select * from (values
        ('Dr. Everson Rezeck', array[3, 6]),
        ('Simone Rezeck', array[3, 6]),
        ('Depilação a laser', array[3, 5, 6]),
        ('Estética', array[2, 3, 6])
    ) as t(name, morning_days)
    loop
        v_agenda := (select id from agendas where name = r.name);
        continue when v_agenda is null;
        v_morning_days := r.morning_days;

        for d in 1..6 loop
            -- Mornings (windows starting before noon).
            if not (d = any (v_morning_days)) then
                delete from agenda_slot_times where agenda_id = v_agenda and weekday = d and start_time < '12:00';
                -- a window running from morning into the afternoon keeps its afternoon
                update agenda_hours set start_time = '13:30'
                where agenda_id = v_agenda and weekday = d and start_time < '12:00' and end_time > '13:30';
                delete from agenda_hours where agenda_id = v_agenda and weekday = d and start_time < '12:00';
            elsif exists (select 1 from agenda_hours where agenda_id = v_agenda and weekday = d and start_time < '12:00') then
                select min(start_time) into v_first from agenda_slot_times where agenda_id = v_agenda and weekday = d and start_time < '12:00';
                -- Fixed times: drop the ones before 8:30, fill 8:30 up to the first one.
                if v_first is not null then
                    delete from agenda_slot_times where agenda_id = v_agenda and weekday = d and start_time < '08:30';
                    insert into agenda_slot_times (agenda_id, weekday, start_time)
                    select v_agenda, d, t::time from generate_series(timestamp '2000-01-01 08:30', timestamp '2000-01-01 00:00' + v_first - interval '1 minute', interval '30 minutes') t
                    on conflict do nothing;
                    if not exists (select 1 from agenda_slot_times where agenda_id = v_agenda and weekday = d and start_time < '12:00') then
                        insert into agenda_slot_times values (v_agenda, d, '08:30') on conflict do nothing;
                    end if;
                end if;
                update agenda_hours set start_time = '08:30' where agenda_id = v_agenda and weekday = d and start_time < '12:00';
            else
                -- A new morning: 8:30 to 12:00, on the agenda's 30-minute rhythm
                -- when it works with fixed times.
                insert into agenda_hours (agenda_id, weekday, start_time, end_time) values (v_agenda, d, '08:30', '12:00');
                if exists (select 1 from agenda_slot_times where agenda_id = v_agenda and weekday = d) then
                    insert into agenda_slot_times (agenda_id, weekday, start_time)
                    select v_agenda, d, t::time from generate_series(timestamp '2000-01-01 08:30', timestamp '2000-01-01 11:30', interval '30 minutes') t
                    on conflict do nothing;
                end if;
            end if;

            -- Afternoons (Monday to Friday): start at 13:30.
            if d between 1 and 5 then
                select min(start_time) into v_first from agenda_slot_times where agenda_id = v_agenda and weekday = d and start_time >= '12:00';
                if v_first is not null and v_first > '13:30' then
                    insert into agenda_slot_times (agenda_id, weekday, start_time)
                    select v_agenda, d, t::time from generate_series(timestamp '2000-01-01 13:30', timestamp '2000-01-01 00:00' + v_first - interval '1 minute', interval '30 minutes') t
                    on conflict do nothing;
                end if;
                update agenda_hours set start_time = '13:30'
                where agenda_id = v_agenda and weekday = d and start_time >= '12:00' and start_time <> '13:30';
            end if;
        end loop;
    end loop;

    -- Estética on Saturday: the same one-hour rhythm as the week (8:30 to 13:30).
    v_agenda := (select id from agendas where name = 'Estética');
    if v_agenda is not null and exists (select 1 from agenda_slot_times where agenda_id = v_agenda and weekday = 6) then
        delete from agenda_slot_times where agenda_id = v_agenda and weekday = 6;
        insert into agenda_slot_times (agenda_id, weekday, start_time)
        select v_agenda, 6, t::time
        from generate_series(timestamp '2000-01-01 08:30', timestamp '2000-01-01 00:00' + (select max(end_time) from agenda_hours where agenda_id = v_agenda and weekday = 6) - interval '60 minutes', interval '60 minutes') t;
    end if;
end;
$$;
