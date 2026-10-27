// FastClinic kept each patient's record as one growing text where every visit
// is a line starting with its date: "07.07.98 - Peeling face total". This
// splits it into dated entries for the new record timeline without losing
// text: lines that don't start with a valid date stay with the entry above.

const LINE_DATE = /^\s*(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})(?!\d)\s*[-–—:]*\s*/;
const SEPARATOR = /^\s*[=\-_*~.]{3,}\s*$/;
const MIN_YEAR = 1990;

export function parseLegacyDate(day, month, year, today = new Date()) {
  let y = Number(year);
  if (year.length === 2) {
    const pivot = today.getUTCFullYear() % 100;
    y += y <= pivot ? 2000 : 1900;
  }
  const d = Number(day);
  const m = Number(month);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  if (y < MIN_YEAR || date.getTime() > today.getTime() + 86_400_000) return null;
  return date.toISOString().slice(0, 10);
}

// Returns [{ date: 'YYYY-MM-DD' | null, content }] in the original order.
// `date` is null only for text written before the first dated line.
export function splitHistory(text, today = new Date()) {
  if (!text) return [];
  const entries = [];
  let current = null;
  for (const rawLine of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (SEPARATOR.test(line)) continue;
    const match = line.match(LINE_DATE);
    const date = match ? parseLegacyDate(match[1], match[2], match[3], today) : null;
    if (date) {
      current = { date, lines: [line.slice(match[0].length)] };
      entries.push(current);
    } else if (line.trim() !== '') {
      if (!current) {
        current = { date: null, lines: [] };
        entries.push(current);
      }
      current.lines.push(line);
    }
  }
  return entries
    .map((e) => ({ date: e.date, content: e.lines.join('\n').trim() }))
    .filter((e) => e.content !== '');
}
