import { useState } from 'react';
import { Check } from 'lucide-react';
import { supabase, must } from '../lib/supabase.js';
import { useLoad } from '../lib/hooks.js';
import { useToast } from '../context/ToastContext.jsx';
import { formatMoney, methodLabel, PAYMENT_METHODS } from '../lib/format.js';
import { formatDay, localDay } from '../lib/time.js';

// The patient's payments. Kept out of sight behind a "$" button so it is not
// on screen while the patient is in the room.
export function PaymentsPanel({ patientId, appointmentId }) {
  const toast = useToast();
  const { data: payments = [], reload } = useLoad(
    () => must(supabase.from('payments').select('*').eq('patient_id', patientId).order('occurred_on', { ascending: false }).limit(50)),
    [patientId],
  );
  const [form, setForm] = useState({ amount: '', method: 'pix', installments: 1, status: 'pago', occurred_on: localDay(), description: '' });
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function add() {
    const raw = String(form.amount).trim();
    // "1.283,50" (Brazilian) or "80.50"
    const amount = Number(raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw);
    if (!(amount > 0)) return toast.error('Informe o valor.');
    const { error } = await supabase.from('payments').insert({
      patient_id: patientId,
      appointment_id: appointmentId ?? null,
      amount,
      method: form.status === 'pago' ? form.method : (form.method || null),
      installments: Number(form.installments) || 1,
      status: form.status,
      occurred_on: form.occurred_on,
      description: form.description.trim() || null,
    });
    if (error) return toast.error(error);
    setForm((f) => ({ ...f, amount: '', description: '' }));
    toast.info('Lançamento registrado.');
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
      <button type="button" className="btn btn-primary" onClick={add}>Registrar lançamento</button>
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
          </div>
        ))}
      </div>
    </div>
  );
}
