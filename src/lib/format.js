export function initials(name) {
  const parts = String(name ?? '').trim().split(/\s+/).map((p) => p.replace(/[^\p{L}]/gu, '')).filter((p) => p && !/^dra?$/i.test(p));
  if (parts.length === 0) return '?';
  return ((parts[0][0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const formatMoney = (value) => money.format(Number(value ?? 0));

// "1.283,50" (Brazilian) or "80.50" → 1283.5; NaN when it is not a number.
export function parseMoney(text) {
  const raw = String(text ?? '').trim().replace(/^R\$\s*/i, '');
  return Number(raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw);
}

export function whatsappLink(phone) {
  let d = String(phone ?? '').replace(/\D/g, '');
  if (d.length < 10) return null;
  if (!d.startsWith('55')) d = `55${d}`;
  return `https://wa.me/${d}`;
}

// What the clinic offers when recording a payment (04/11). "Pix" and
// "Boleto" remain only to name older entries.
export const PAYMENT_METHODS = [
  { id: 'pix_everson', label: 'Pix Everson' },
  { id: 'pix_simone', label: 'Pix Simone' },
  { id: 'transferencia', label: 'TED' },
  { id: 'cartao_credito', label: 'Cartão de crédito' },
  { id: 'cartao_debito', label: 'Cartão de débito' },
  { id: 'dinheiro', label: 'Dinheiro' },
  { id: 'outro', label: 'Outro' },
];
const OLD_METHODS = [{ id: 'pix', label: 'Pix' }, { id: 'boleto', label: 'Boleto' }];

export const methodLabel = (id) => [...PAYMENT_METHODS, ...OLD_METHODS].find((m) => m.id === id)?.label ?? '—';

export const ROLE_LABEL = { admin: 'Administrador', secretaria: 'Secretária', profissional: 'Profissional' };

export function errorMessage(error) {
  const msg = error?.message ?? String(error ?? '');
  if (/duplicate key|already exists/i.test(msg)) return 'Já existe um registro com esses dados.';
  if (/row-level security|permission denied/i.test(msg)) return 'Você não tem permissão para isso.';
  if (/Failed to fetch|NetworkError/i.test(msg)) return 'Sem conexão com o servidor. Tente de novo.';
  return msg || 'Algo deu errado.';
}
