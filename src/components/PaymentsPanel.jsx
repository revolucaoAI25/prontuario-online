import { useEffect, useState } from 'react';
import { Check, Pencil, Trash2, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { supabase, must } from '../lib/supabase.js';
import { useLoad } from '../lib/hooks.js';
import { useToast } from '../context/ToastContext.jsx';
import { formatMoney, methodLabel, parseMoney, PAYMENT_METHODS } from '../lib/format.js';
import { formatDay, localDay, zonedToUtc } from '../lib/time.js';

const COUNTER = ''; // no agenda: a product sold at the front desk

// The patient's payments. Kept out of sight behind a "$" button so it is not
// on screen while the patient is in the room. Each payment counts for an
// agenda; the database hides the doctors' agendas from the rest of the team,
// so a payment recorded for them leaves this list once saved.
export function PaymentsPanel({ patientId, appointmentId, agendaId }) {
  const toast = useToast();
  const { isAdmin } = useAuth();
  const [editingId, setEditingId] = useState(null);
  const { data: payments = [], reload } = useLoad(
    () => must(supabase.from('payments').select('*').eq('patient_id', patientId).order('occurred_on', { ascending: false }).limit(50)),
    [patientId],
  );
  const { data: agendas = [] } = useLoad(() => must(supabase.from('agendas').select('id, name, finance_shared').eq('active', true).order('sort_order')), []);
  // Outside a visit, suggest the agenda of the patient's latest visit.
  const { data: lastAgenda } = useLoad(async () => {
    if (agendaId) return agendaId;
    const rows = await must(supabase.from('appointments').select('agenda_id').eq('patient_id', patientId).neq('status', 'cancelado')
      .lte('starts_at', zonedToUtc(localDay(), '23:59').toISOString()).order('starts_at', { ascending: false }).limit(1));
    return rows[0]?.agenda_id ?? COUNTER;
  }, [patientId, agendaId]);

  const blank = { amount: '', method: 'pix', installments: 1, status: 'pago', occurred_on: localDay(), description: '', agenda_id: lastAgenda ?? COUNTER };
  const [form, setForm] = useState(blank);
  useEffect(() => { if (!editingId && lastAgenda !== undefined) setForm((f) => ({ ...f, agenda_id: lastAgenda })); }, [lastAgenda]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const agendaName = (id) => agendas.find((a) => a.id === id)?.name;

  async function add() {
    const amount = parseMoney(form.amount);
    if (!(amount > 0)) return toast.error('Informe o valor.');
    const values = {
      amount,
      method: form.status === 'pago' ? form.method : (form.method || null),
      installments: Number(form.installments) || 1,
      status: form.status,
      occurred_on: form.occurred_on,
      description: form.description.trim() || null,
      agenda_id: form.agenda_id || null,
    };
    const { error } = editingId
      ? await supabase.from('payments').update(values).eq('id', editingId)
      : await supabase.from('payments').insert({ ...values, patient_id: patientId, appointment_id: appointmentId ?? null });
    if (error) return toast.error(error);
    const hidden = !isAdmin && values.agenda_id && !agendas.find((a) => a.id === values.agenda_id)?.finance_shared;
    toast.info(hidden
      ? `Lançamento registrado. Os valores da agenda ${agendaName(values.agenda_id)} ficam visíveis só para o administrador.`
      : editingId ? 'Lançamento atualizado.' : 'Lançamento registrado.');
    setForm({ ...blank, agenda_id: lastAgenda ?? COUNTER });
    setEditingId(null);
    reload();
  }

  function edit(p) {
    setEditingId(p.id);
    setForm({
      amount: String(p.amount).replace('.', ','), method: p.method ?? 'pix', installments: p.installments, status: p.status,
      occurred_on: p.occurred_on, description: p.description ?? '', agenda_id: p.agenda_id ?? COUNTER,
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
        <div className="field"><label>Agenda</label>
          <select className="select" value={form.agenda_id} onChange={set('agenda_id')} disabled={Boolean(appointmentId) && !editingId}>
            {agendas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            <option value={COUNTER}>Balcão (produto, sem agenda)</option>
          </select>
        </div>
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
        <div className="field full"><label>Descrição</label><input className="input" value={form.description} onChange={set('description')} placeholder="ex.: Botox" /></div>
      </div>
      <div className="row">
        <button type="button" className="btn btn-primary" onClick={add}>{editingId ? 'Salvar alteração' : 'Registrar lançamento'}</button>
        {editingId && <button type="button" className="btn" onClick={() => { setEditingId(null); setForm({ ...blank, agenda_id: lastAgenda ?? COUNTER }); }}><X /> Cancelar edição</button>}
      </div>
      <div>
        <div className="section-title" style={{ marginTop: 6 }}>Histórico</div>
        {payments.length === 0 && <div className="small muted">Nenhum lançamento.</div>}
        {payments.map((p) => (
          <div key={p.id} className="side-item row">
            <div className="grow">
              <div style={{ fontWeight: 700 }}>{formatMoney(p.amount)} <span className="small muted">· {methodLabel(p.method)}{p.installments > 1 ? ` em ${p.installments}x` : ''}</span></div>
              <div className="small muted">{formatDay(p.occurred_on)} · {agendaName(p.agenda_id) ?? 'Balcão'}{p.description ? ` · ${p.description}` : ''}</div>
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
