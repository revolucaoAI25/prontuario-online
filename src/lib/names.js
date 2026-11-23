// Names and phones as a message tool wants them.

const CONNECTORS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'di', 'du', 'del', 'van', 'von']);

// "MARIA DE LOURDES SILVA" → "Maria de Lourdes Silva"
export function properName(name) {
  return String(name ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR').split(' ')
    .map((w, i) => (i > 0 && CONNECTORS.has(w) ? w : w.replace(/(^|[-'])(\p{L})/gu, (_, sep, ch) => sep + ch.toLocaleUpperCase('pt-BR'))))
    .join(' ');
}

export function firstName(name) {
  return properName(name).split(' ')[0] ?? '';
}

// First and second name; a "de/da/dos…" in between comes along:
// "Ana Paula Costa" → "Ana Paula", "Maria de Lourdes Silva" → "Maria de Lourdes".
export function firstTwoNames(name) {
  const words = properName(name).split(' ').filter(Boolean);
  if (words.length <= 1) return words.join('');
  const out = [words[0]];
  for (let i = 1; i < words.length; i++) {
    out.push(words[i]);
    if (!CONNECTORS.has(words[i])) break;
  }
  return out.join(' ');
}

// WhatsApp format: 55 + DDD + number, digits only. Null when there is no
// DDD (fewer than 10 digits) or it is too long to be a Brazilian number.
export function whatsappDigits(phone) {
  let d = String(phone ?? '').replace(/\D/g, '');
  if (d.startsWith('0')) d = d.replace(/^0+/, ''); // 0 31 9…
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) return d;
  if (d.length === 10 || d.length === 11) return `55${d}`;
  return null;
}
