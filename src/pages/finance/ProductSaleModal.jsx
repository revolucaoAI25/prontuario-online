import { useState } from 'react';
import { supabase, must } from '../../lib/supabase.js';
import { useLoad } from '../../lib/hooks.js';
import { useToast } from '../../context/ToastContext.jsx';
import { localDay } from '../../lib/time.js';
import { parseMoney, PAYMENT_METHODS } from '../../lib/format.js';
import { Field, Modal } from '../../components/ui.jsx';
import { PatientPicker, ensurePatient } from '../../components/PatientPicker.jsx';

// A product sold at the clinic, recorded right in the Financeiro: it goes
// to the "Produtos" card (a payment with no agenda). The buyer is optional
// (someone who just came to buy); the stock products are suggested by name.
export function ProductSaleModal({ day, onClose, onSaved }) {
  const toast = useToast();
  const { data: products = [] } = useLoad(() => must(supabase.from('stock_products').select('name').order('name')), []);
  const [form, setForm] = useState({
    description: '', quantity: '1', amount: '', method: '', installments: 1, status: 'pago', occurred_on: day ?? localDay(),
  });
  const [buyer, setBuyer] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const names = [...new Set(products.map((p) => p.name))];

  async function save() {
    const amount = parseMoney(form.amount);
    if (!form.description.trim()) return toast.error('Informe o produto vendido.');
    if (!(amount > 0)) return toast.error('Informe o valor.');
    if (form.status === 'pago' && !form.method) return toast.error('Escolha a forma de pagamento.');
    setSaving(true);
    try {
      const qty = Number(form.quantity) || 1;
      const patientId = buyer ? await ensurePatient(buyer) : null;
      await must(supabase.from('payments').insert({
        agenda_id: null,
        patient_id: patientId,
        amount,
        method: form.method || null,
        installments: form.method === 'cartao_credito' ? Number(form.installments) || 1 : 1,
        status: form.status,
        occurred_on: form.occurred_on,
        description: qty > 1 ? `${qty}x ${form.description.trim()}` : form.description.trim(),
      }));
      toast.info('Venda lançada em Produtos.');
      onSaved();
    } catch (error) {
      toast.error(error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Lançar venda de produto" onClose={onClose}
      footer={<>
        <button type="button" className="btn" onClick={onClose}>Cancelar</button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>Lançar venda</button>
      </>}>
      <div className="form-grid">
        <Field label="Produto" full>
          <input className="input" list="stock-product-names" autoFocus value={form.description} onChange={set('description')} placeholder="ex.: Protetor solar FPS 50" />
          <datalist id="stock-product-names">{names.map((n) => <option key={n} value={n} />)}</datalist>
        </Field>
        <Field label="Quantidade"><input className="input" type="number" min="1" max="99" value={form.quantity} onChange={set('quantity')} /></Field>
        <Field label="Valor total (R$)"><input className="input" inputMode="decimal" value={form.amount} onChange={set('amount')} placeholder="0,00" /></Field>
        <Field label="Forma de pagamento">
          <select className="select" value={form.method} onChange={set('method')}>
            <option value="">Escolha</option>
            {PAYMENT_METHODS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </Field>
        {form.method === 'cartao_credito' ? (
          <Field label="Parcelas"><input className="input" type="number" min="1" max="24" value={form.installments} onChange={set('installments')} /></Field>
        ) : (
          <Field label="Situação">
            <select className="select" value={form.status} onChange={set('status')}>
              <option value="pago">Pago</option>
              <option value="pendente">A receber</option>
            </select>
          </Field>
        )}
        <Field label="Data"><input className="input" type="date" value={form.occurred_on} max={localDay()} onChange={set('occurred_on')} /></Field>
        <Field label="Cliente (opcional)" full hint="Se for paciente, a venda aparece também no $ dela.">
          <PatientPicker value={buyer} onChange={setBuyer} />
        </Field>
      </div>
    </Modal>
  );
}
