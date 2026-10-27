import { useState } from 'react';
import { Check, Pencil, Trash2, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { supabase, must } from '../lib/supabase.js';
import { useLoad } from '../lib/hooks.js';
import { useToast } from '../context/ToastContext.jsx';
import { formatMoney, methodLabel, PAYMENT_METHODS } from '../lib/format.js';
import { formatDay, localDay } from '../lib/time.js';

// The patient's payments. Kept out of sight behind a "$" button so it is not
// on screen while the patient is in the room.
export function PaymentsPanel({ patientId, appointmentId }) {
  const toast = useToast();
  const { isAdmin } = useAuth();
  const [editingId, setEditingId] = useState(null);
  const { data: payments = [], reload } = useLoad(
    () => must(supabase.from('payments').select('*').eq('patient_id', patientId).order('occurred_on', { ascending: false }).limit(50)),
    [patientId],
  );
  const blank = { amount: '', method: 'pix', installments: 1, status: 'pago', occurred_on: localDay(), description: '' };
  const [form, setForm] = useState(blank);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function add() {
    const raw = String(form.amount).trim();
    // "1.283,50" (Brazilian) or "80.50"
    const amount = Number(raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw);
    if (!(amount > 0)) return toast.error('Informe o valor.');
    const values = {
      amount,
      method: form.status === 'pago' ? form.method : (form.method || null),
      installments: Number(form.installments) || 1,
      status: form.status,
      occurred_on: form.occurred_on,
      description: form.description.trim() || null,
    };
    const { error } = editingId
      ? await supabase.from('payments').update(values).eq('id', editingId)
      : await supabase.from('payments').insert({ ...values, patient_id: patientId, appointment_id: appointmentId ?? null });
    if (error) return toast.error(error);
    setForm(blank);
    toast.info(editingId ? 'Lançamento atualizado.' : 'Lançamento registrado.');
    setEditingId(null);
    reload();
  }

  function edit(p) {
    setEditingId(p.id);
    setForm({
      amount: String(p.amount).replace('.', ','), method: p.method ?? 'pix', installments: p.installments, status: p.status,
      occurred_on: p.occurred_on, description: p.description ?? '',
    });
  }

  async function remove(p) {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Apagar o lançamento de ${formatMoney(p.amount)} (${formatDay(p.occurred_on)})?`)) return;
    const { error } = await supabase.from('payments').delete().eq('id', p.id);
    if (error) return toast.error(error);
    if (editingId === p.id) { setEditingId(null); setForm(blank); }
    reload();
  }

  async function markPaid(payment) {
    const { error } = await supabase.from('payments').update({ status: 'pago', method: payment.method ?? 'pix', occurred_on: localDay() }).eq('id', payment.id);
    if (error) return toast.error(error);
    reload();
  }

  const pending = payments.filter((p) => p.status === 'pendente').reduce((s, p) => s + Number(p.amount), 0);

  return (
    <div className="stack">
      {pending > 0 && <div className="banner">Pendente: {formatMoney(pending)}</div>}
      <div className="form-grid">
        <div className="field"><label>Valor (R$)</label><input className="input" inputMode="decimal" value={form.amount} onChange={set('amount')} placeholder="0,00" /></div>
        <div className="field"><label>Situação</label>
          <select className="select" value={form.status} onChange={set('status')}>
            <option value="pago">Pago</option>
            <option value="pendente">Pendente</option>
          </select>
        </div>
        <div className="field"><label>Forma de pagamento</label>
          <select className="select" value={form.method} onChange={set('method')}>
            {PAYMENT_METHODS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>
        <div className="field"><label>Parcelas</label><input className="input" type="number" min="1" max="24" value={form.installments} onChange={set('installments')} /></div>
        <div className="field"><label>Data</label><input className="input" type="date" value={form.occurred_on} onChange={set('occurred_on')} /></div>
        <div className="field"><label>Descrição</label><input className="input" value={form.description} onChange={set('description')} placeholder="ex.: Botox" /></div>
      </div>
      <div className="row">
        <button type="button" className="btn btn-primary" onClick={add}>{editingId ? 'Salvar alteração' : 'Registrar lançamento'}</button>
        {editingId && <button type="button" className="btn" onClick={() => { setEditingId(null); setForm(blank); }}><X /> Cancelar edição</button>}
      </div>
      <div>
        <div className="section-title" style={{ marginTop: 6 }}>Histórico</div>
        {payments.length === 0 && <div className="small muted">Nenhum lançamento.</div>}
        {payments.map((p) => (
          <div key={p.id} className="side-item row">
            <div className="grow">
              <div style={{ fontWeight: 700 }}>{formatMoney(p.amount)} <span className="small muted">· {methodLabel(p.method)}{p.installments > 1 ? ` em ${p.installments}x` : ''}</span></div>
              <div className="small muted">{formatDay(p.occurred_on)}{p.description ? ` · ${p.description}` : ''}</div>
            </div>
            {p.status === 'pendente'
              ? <button type="button" className="btn btn-sm" onClick={() => markPaid(p)}><Check /> Marcar pago</button>
              : <span className="tag ok">Pago</span>}
            <button type="button" className="icon-btn ghost" onClick={() => edit(p)} aria-label="Editar lançamento" title="Editar"><Pencil /></button>
            {isAdmin && <button type="button" className="icon-btn ghost" onClick={() => remove(p)} aria-label="Apagar lançamento" title="Apagar"><Trash2 /></button>}
          </div>
        ))}
      </div>
    </div>
  );
}
