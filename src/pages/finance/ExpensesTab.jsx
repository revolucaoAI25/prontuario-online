import { useState } from 'react';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import { supabase, must } from '../../lib/supabase.js';
import { useLoad } from '../../lib/hooks.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { formatMoney, methodLabel, parseMoney, PAYMENT_METHODS } from '../../lib/format.js';
import { formatDay, localDay } from '../../lib/time.js';
import { Empty, Field } from '../../components/ui.jsx';
import { usePeriod } from './period.jsx';

const SUGGESTED = ['Compras', 'Contas', 'Material', 'Limpeza', 'Alimentação', 'Manutenção', 'Impostos', 'Salários'];

// The clinic's day-to-day spending, recorded at the front desk: "cesta R$ 300,
// conta de luz R$ 150". Admin and reception; only the admin deletes.
export function ExpensesTab() {
  const toast = useToast();
  const { isAdmin } = useAuth();
  const { from, to, picker, label } = usePeriod('mes');
  const blank = { occurred_on: localDay(), description: '', category: '', amount: '', method: '' };
  const [form, setForm] = useState(blank);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const { data: rows = [], reload } = useLoad(
    () => must(supabase.from('expenses').select('*, author:staff(full_name)').gte('occurred_on', from).lte('occurred_on', to)
      .order('occurred_on', { ascending: false }).order('created_at', { ascending: false })),
    [from, to],
  );
  const { data: usedCategories = [] } = useLoad(
    () => must(supabase.from('expenses').select('category').not('category', 'is', null).order('created_at', { ascending: false }).limit(300))
      .then((r) => [...new Set(r.map((x) => x.category))]),
    [rows.length],
  );
  const categories = [...new Set([...usedCategories, ...SUGGESTED])];

  const total = rows.reduce((s, r) => s + Number(r.amount), 0);
  const byCategory = Object.entries(rows.reduce((acc, r) => {
    const key = r.category || 'Sem categoria';
    acc[key] = (acc[key] ?? 0) + Number(r.amount);
    return acc;
  }, {})).sort((a, b) => b[1] - a[1]);

  async function save() {
    const amount = parseMoney(form.amount);
    if (!form.description.trim()) return toast.error('Diga com o que foi a despesa.');
    if (!(amount > 0)) return toast.error('Informe o valor.');
    const values = {
      occurred_on: form.occurred_on,
      description: form.description.trim(),
      category: form.category.trim() || null,
      amount,
      method: form.method || null,
    };
    setSaving(true);
    const { error } = editingId
      ? await supabase.from('expenses').update(values).eq('id', editingId)
      : await supabase.from('expenses').insert(values);
    setSaving(false);
    if (error) return toast.error(error);
    toast.info(editingId ? 'Despesa atualizada.' : 'Despesa lançada.');
    setForm({ ...blank, occurred_on: form.occurred_on });
    setEditingId(null);
    reload();
  }

  function edit(e) {
    setEditingId(e.id);
    setForm({ occurred_on: e.occurred_on, description: e.description, category: e.category ?? '', amount: String(e.amount).replace('.', ','), method: e.method ?? '' });
  }

  async function remove(e) {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Apagar a despesa "${e.description}" de ${formatMoney(e.amount)}?`)) return;
    const { error } = await supabase.from('expenses').delete().eq('id', e.id);
    if (error) return toast.error(error);
    if (editingId === e.id) { setEditingId(null); setForm(blank); }
    reload();
  }

  return (
    <>
      <div className="card card-pad" style={{ marginBottom: 14 }}>
        <div className="section-title">{editingId ? 'Editar despesa' : 'Lançar despesa'}</div>
        <div className="expense-form">
          <Field label="Data"><input className="input" type="date" value={form.occurred_on} onChange={set('occurred_on')} /></Field>
          <Field label="Descrição"><input className="input" value={form.description} onChange={set('description')} placeholder="ex.: Cesta básica, conta de luz" onKeyDown={(e) => e.key === 'Enter' && save()} /></Field>
          <Field label="Categoria">
            <input className="input" list="expense-categories" value={form.category} onChange={set('category')} placeholder="ex.: Compras" />
            <datalist id="expense-categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
          </Field>
          <Field label="Valor (R$)"><input className="input" inputMode="decimal" value={form.amount} onChange={set('amount')} placeholder="0,00" onKeyDown={(e) => e.key === 'Enter' && save()} /></Field>
          <Field label="Pago com">
            <select className="select" value={form.method} onChange={set('method')}>
              <option value="">—</option>
              {PAYMENT_METHODS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </Field>
        </div>
        <div className="row">
          <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>{editingId ? 'Salvar alteração' : <><Plus /> Lançar despesa</>}</button>
          {editingId && <button type="button" className="btn" onClick={() => { setEditingId(null); setForm(blank); }}><X /> Cancelar edição</button>}
        </div>
      </div>

      <div className="row-wrap" style={{ marginBottom: 14 }}>{picker}<span className="small muted">{label}</span></div>

      <div className="row" style={{ alignItems: 'stretch', gap: 14, marginBottom: 14, flexWrap: 'wrap' }}>
        <div className="card kpi" style={{ flex: '1 1 220px' }}><div className="lbl">Total de despesas</div><div className="val" style={{ color: 'var(--danger)' }}>{formatMoney(total)}</div><div className="small muted">{rows.length} {rows.length === 1 ? 'lançamento' : 'lançamentos'}</div></div>
        <div className="card card-pad" style={{ flex: '3 1 380px' }}>
          <div className="section-title">Por categoria</div>
          {byCategory.length === 0 && <div className="small muted">Nenhuma despesa no período.</div>}
          {byCategory.map(([name, value]) => (
            <div key={name} style={{ marginBottom: 10 }}>
              <div className="row small"><b>{name}</b><span className="grow" /><b className="tnum">{formatMoney(value)}</b></div>
              <div className="meter"><div style={{ width: `${(value / (byCategory[0][1] || 1)) * 100}%`, background: 'var(--danger)' }} /></div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <table className="table">
          <thead><tr><th>Data</th><th>Descrição</th><th>Categoria</th><th>Pago com</th><th className="num">Valor</th><th>Lançado por</th><th style={{ width: 90 }} /></tr></thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id} className={editingId === e.id ? 'selected' : ''}>
                <td className="mono">{formatDay(e.occurred_on)}</td>
                <td style={{ fontWeight: 600 }}>{e.description}</td>
                <td>{e.category ?? <span className="muted">—</span>}</td>
                <td>{e.method ? methodLabel(e.method) : <span className="muted">—</span>}</td>
                <td className="num"><b>{formatMoney(e.amount)}</b></td>
                <td className="small muted">{e.author?.full_name ?? '—'}</td>
                <td>
                  <div className="row" style={{ justifyContent: 'flex-end', gap: 2 }}>
                    <button type="button" className="icon-btn ghost" onClick={() => edit(e)} aria-label="Editar despesa" title="Editar"><Pencil /></button>
                    {isAdmin && <button type="button" className="icon-btn ghost" onClick={() => remove(e)} aria-label="Apagar despesa" title="Apagar"><Trash2 /></button>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <Empty>Nenhuma despesa no período.</Empty>}
      </div>
    </>
  );
}
