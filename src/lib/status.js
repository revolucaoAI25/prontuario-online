// Agenda colors agreed with the clinic (pastel): see styles.css .st-*.
export const STATUSES = [
  { id: 'agendado', label: 'Agendado', legend: 'Agendado (não confirmou)' },
  { id: 'confirmado', label: 'Confirmado', legend: 'Confirmado' },
  { id: 'chegou', label: 'Chegou', legend: 'Paciente chegou' },
  { id: 'pediu_remarcar', label: 'Pediu p/ remarcar', legend: 'Pediu para remarcar' },
  { id: 'nao_compareceu', label: 'Não compareceu', legend: 'Não compareceu' },
  { id: 'cancelado', label: 'Cancelado', legend: 'Cancelado' },
];

export const statusLabel = (id) => STATUSES.find((s) => s.id === id)?.label ?? id;

// Statuses that keep the time slot occupied (mirrors appointment_holds_slot in SQL).
export const HOLDS_SLOT = new Set(['agendado', 'confirmado', 'chegou']);
