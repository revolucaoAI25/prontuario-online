import { addDays, localDay, localTime, weekday } from '../../lib/time.js';

const WEEKDAYS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
const MAX_ITEMS = 3;

const shortName = (name) => {
  const parts = String(name ?? '').trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0] ?? '';
};

// First Monday on or before the 1st, through the Sunday after the month ends.
export function monthDays(month) {
  const first = `${month}-01`;
  const start = addDays(first, -((weekday(first) + 6) % 7));
  const days = [];
  for (let d = start; days.length < 42; d = addDays(d, 1)) {
    if (days.length % 7 === 0 && d > first && d.slice(0, 7) !== month) break;
    days.push(d);
  }
  return days;
}

export function MonthGrid({ month, appointments, agendaColor, onPickDay }) {
  const today = localDay();
  const byDay = new Map();
  for (const appt of appointments) {
    const day = localDay(appt.starts_at);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(appt);
  }
  return (
    <div className="month">
      <div className="month-head">{WEEKDAYS.map((d) => <div key={d}>{d}</div>)}</div>
      <div className="month-grid">
        {monthDays(month).map((day) => {
          const list = (byDay.get(day) ?? []).sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
          const active = list.filter((a) => a.status !== 'cancelado');
          const dow = weekday(day);
          return (
            <div
              key={day}
              className={`month-cell ${day.slice(0, 7) !== month ? 'other' : ''} ${day === today ? 'today' : ''} ${dow === 0 || dow === 6 ? 'weekend' : ''}`}
              onClick={() => onPickDay(day)}
              data-day={day}
            >
              <div className="mtop">
                <span className="mday">{Number(day.slice(8))}</span>
                {active.length > 0 && <span className="mcount">{active.length}</span>}
              </div>
              {list.slice(0, MAX_ITEMS).map((a) => (
                <div key={a.id} className={`month-item st-${a.status}`} title={`${localTime(a.starts_at)} · ${a.patient?.full_name}`}>
                  <i style={{ background: agendaColor(a.agenda_id) }} />
                  <span className="tm">{localTime(a.starts_at)}</span>
                  <span className="nm">{shortName(a.patient?.full_name)}</span>
                </div>
              ))}
              {list.length > MAX_ITEMS && <div className="month-more">+{list.length - MAX_ITEMS} mais</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
