// Every date/time shown or typed in the app is clinic time (Brasília),
// whatever the computer's own timezone is.
export const TZ = 'America/Sao_Paulo';

const partsFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function parts(date) {
  const p = Object.fromEntries(partsFormat.formatToParts(new Date(date)).map((x) => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second };
}

const pad = (n) => String(n).padStart(2, '0');

export function localDay(date = new Date()) {
  const p = parts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function localTime(date) {
  const p = parts(date);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

export function localMinutes(date) {
  const p = parts(date);
  return p.hour * 60 + p.minute;
}

function offsetMinutes(date) {
  const p = parts(date);
  return (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - date.getTime()) / 60000;
}

// 'YYYY-MM-DD' + 'HH:MM' in clinic time → Date (UTC instant).
export function zonedToUtc(day, time = '00:00') {
  const [y, mo, d] = day.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  let ts = naive - offsetMinutes(new Date(naive)) * 60000;
  ts = naive - offsetMinutes(new Date(ts)) * 60000;
  return new Date(ts);
}

export function addDays(day, n) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}

export function weekday(day) {
  return new Date(`${day}T12:00:00Z`).getUTCDay();
}

export const minutesToTime = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
export const timeToMinutes = (t) => {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + (m || 0);
};

const longDay = new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
const shortDay = new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' });

export function formatDayLong(day) {
  const text = longDay.format(new Date(`${day}T12:00:00Z`));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const fullDate = new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });
const weekdayName = new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', weekday: 'long' });

export const formatFullDate = (day) => fullDate.format(new Date(`${day}T12:00:00Z`));
export function formatWeekday(day) {
  const text = weekdayName.format(new Date(`${day}T12:00:00Z`));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function formatDay(day) {
  return day ? shortDay.format(new Date(`${String(day).slice(0, 10)}T12:00:00Z`)) : '';
}

export function formatDateTime(date) {
  return `${formatDay(localDay(date))} ${localTime(date)}`;
}

export function relativeDayLabel(day) {
  const today = localDay();
  if (day === today) return 'Hoje';
  if (day === addDays(today, 1)) return 'Amanhã';
  if (day === addDays(today, -1)) return 'Ontem';
  return '';
}

export function ageFrom(birthDate) {
  if (!birthDate) return null;
  const [y, m, d] = birthDate.split('-').map(Number);
  const today = localDay().split('-').map(Number);
  let age = today[0] - y;
  if (today[1] < m || (today[1] === m && today[2] < d)) age--;
  return age;
}
