// The agenda shows four statuses, in the clinic's palette (styles.css .st-*).
// The database (and the API) keep their six codes: "pediu para remarcar",
// "não compareceu" and "cancelado" all show as "A remarcar". A booking taken
// off the agenda has removed_at set.
export const STATUSES = [
  { id: 'agendado', label: 'Agendado', legend: 'Agendado (não confirmou)', code: 'agendado' },
  { id: 'confirmado', label: 'Confirmado', legend: 'Confirmado', code: 'confirmado' },
  { id: 'chegou', label: 'Chegou', legend: 'Paciente chegou', code: 'chegou' },
  { id: 'remarcar', label: 'A remarcar', legend: 'A remarcar', code: 'pediu_remarcar' },
];

const SHOWN_AS = { pediu_remarcar: 'remarcar', nao_compareceu: 'remarcar', cancelado: 'remarcar' };

// The status as the app shows it: agendado, confirmado, chegou or remarcar.
export const displayStatus = (code) => SHOWN_AS[code] ?? code;

export const statusLabel = (code) => STATUSES.find((s) => s.id === displayStatus(code))?.label ?? code;

// Statuses that keep the time slot occupied (mirrors appointment_holds_slot in SQL).
export const HOLDS_SLOT = new Set(['agendado', 'confirmado', 'chegou']);
