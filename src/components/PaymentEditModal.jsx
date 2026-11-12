import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { supabase, must } from '../lib/supabase.js';
import { useLoad } from '../lib/hooks.js';
import { useToast } from '../context/ToastContext.jsx';
import { formatDay } from '../lib/time.js';
import { formatMoney, methodLabel, parseMoney, PAYMENT_METHODS } from '../lib/format.js';
import { Field, Modal } from './ui.jsx';

// Fix a payment already recorded: amount, payment method, installments,
// paid/pending, date, agenda or description. Anyone who sees it can fix it;
// deleting stays with the administrator.
export function PaymentEditModal({ payment, onClose, onSaved }) {
  const toast = useToast();
  const { isAdmin } = useAuth();
  const { data: agendas = [] } = useLoad(() => must(supabase.from('agendas').select('id, name, finance_shared').eq('active', true).order('sort_order')), []);
  const [form, setForm] = useState({
    amount: String(payment.amount).replace('.', ','),
    method: payment.method ?? '',
    installments: payment.installments ?? 1,
    status: payment.status,
    occurred_on: payment.occurred_on,
    description: payment.description ?? '',
    agenda_id: payment.agenda_id ?? '',
  });
  const [saving, setSaving] = useState(false);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function save() {
    const amount = parseMoney(form.amount);
    if (!(amount > 0)) return toast.error('Informe o valor.');
    if (form.status === 'pago' && !form.method) return toast.error('Escolha a forma de pagamento.');
    setSaving(true);
    const values = {
      amount,
      method: form.method || null,
      installments: Number(form.installments) || 1,
      status: form.status,
      occurred_on: form.occurred_on,
      description: form.description.trim() || null,
      agenda_id: form.agenda_id || null,
    };
    const { error } = await supabase.from('payments').update(values).eq('id', payment.id);
    setSaving(false);
    if (error) return toast.error(error);
    const hidden = !isAdmin && values.agenda_id && !agendas.find((a) => a.id === values.agenda_id)?.finance_shared;
    toast.info(hidden ? 'Lançamento atualizado. Essa agenda fica visível só para o administrador.' : 'Lançamento atualizado.');
    return onSaved();
  }

  async function remove() {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Apagar o lançamento de ${formatMoney(payment.amount)} (${formatDay(payment.occurred_on)})?`)) return null;
    const { error } = await supabase.from('payments').delete().eq('id', payment.id);
    if (error) return toast.error(error);
    toast.info('Lançamento apagado.');
    return onSaved();
  }

  return (
    <Modal title="Editar lançamento" onClose={onClose}
      footer={<>
        {isAdmin && <button type="button" className="btn btn-ghost" style={{ color: 'var(--danger)', marginRight: 'auto' }} onClick={remove}><Trash2 /> Apagar</button>}
        <button type="button" className="btn" onClick={onClose}>Cancelar</button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>Salvar alteração</button>
      </>}>
      {payment.patient?.full_name && <div className="small muted" style={{ marginBottom: 12 }}>{payment.patient.full_name}</div>}
      <div className="form-grid">
        <Field label="Valor (R$)"><input className="input" inputMode="decimal" autoFocus value={form.amount} onChange={set('amount')} placeholder="0,00" /></Field>
        <Field label="Forma de pagamento">
          <select className="select" value={form.method} onChange={set('method')}>
            {!form.method && <option value="">Escolha</option>}
            {PAYMENT_METHODS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            {form.method && !PAYMENT_METHODS.some((m) => m.id === form.method) && <option value={form.method}>{methodLabel(form.method)}</option>}
          </select>
        </Field>
        <Field label="Parcelas"><input className="input" type="number" min="1" max="24" value={form.installments} onChange={set('installments')} /></Field>
        <Field label="Situação">
          <select className="select" value={form.status} onChange={set('status')}>
            <option value="pago">Pago</option>
            <option value="pendente">Pendente</option>
          </select>
        </Field>
        <Field label="Data"><input className="input" type="date" value={form.occurred_on} onChange={set('occurred_on')} /></Field>
        <Field label="Agenda">
          <select className="select" value={form.agenda_id} onChange={set('agenda_id')}>
            {agendas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            {form.agenda_id && !agendas.some((a) => a.id === form.agenda_id) && <option value={form.agenda_id}>{payment.agenda?.name ?? 'Agenda antiga'}</option>}
            <option value="">Balcão (produto, sem agenda)</option>
          </select>
        </Field>
        <Field label="Descrição" full><input className="input" value={form.description} onChange={set('description')} placeholder="ex.: Botox" /></Field>
      </div>
    </Modal>
  );
}
