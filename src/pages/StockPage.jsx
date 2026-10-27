import { useState } from 'react';
import { Plus, ArrowDownToLine, ArrowUpFromLine, Search, Trash2 } from 'lucide-react';
import { supabase, must } from '../lib/supabase.js';
import { useLoad } from '../lib/hooks.js';
import { useToast } from '../context/ToastContext.jsx';
import { formatDateTime } from '../lib/time.js';
import { Empty, Field, Modal } from '../components/ui.jsx';

const qty = (n) => Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function ProductModal({ product, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', unit: 'un', location: '', min_quantity: 0, notes: '', ...product });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function save() {
    if (!form.name.trim()) return toast.error('Informe o nome do produto.');
    const row = { name: form.name.trim(), unit: form.unit.trim() || 'un', location: form.location?.trim() || null, min_quantity: Number(form.min_quantity) || 0, notes: form.notes?.trim() || null };
    const { error } = product?.id
      ? await supabase.from('stock_products').update(row).eq('id', product.id)
      : await supabase.from('stock_products').insert(row);
    if (error) return toast.error(error);
    onSaved();
  }

  async function remove() {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Apagar "${product.name}" e todo o histórico de entradas e saídas dele?`)) return;
    const { error } = await supabase.from('stock_products').delete().eq('id', product.id);
    if (error) return toast.error(error);
    onSaved();
  }

  return (
    <Modal title={product?.id ? 'Editar produto' : 'Novo produto'} onClose={onClose}
      footer={<>
        {product?.id && <button type="button" className="btn btn-ghost" style={{ color: 'var(--danger)', marginRight: 'auto' }} onClick={remove}><Trash2 /> Apagar produto</button>}
        <button type="button" className="btn" onClick={onClose}>Cancelar</button><button type="button" className="btn btn-primary" onClick={save}>Salvar</button>
      </>}>
      <div className="form-grid">
        <Field label="Nome" full><input className="input" autoFocus value={form.name} onChange={set('name')} /></Field>
        <Field label="Unidade"><input className="input" value={form.unit} onChange={set('unit')} placeholder="un, ml, cx" /></Field>
        <Field label="Estoque mínimo"><input className="input" type="number" min="0" value={form.min_quantity} onChange={set('min_quantity')} /></Field>
        <Field label="Local" full><input className="input" value={form.location ?? ''} onChange={set('location')} placeholder="ex.: Armário da sala 2" /></Field>
        <Field label="Observações" full><input className="input" value={form.notes ?? ''} onChange={set('notes')} /></Field>
      </div>
    </Modal>
  );
}

function MovementModal({ product, type, onClose, onSaved }) {
  const toast = useToast();
  const [quantity, setQuantity] = useState('');
  const [note, setNote] = useState('');
  async function save() {
    const value = Number(String(quantity).replace(',', '.'));
    if (!(value > 0)) return toast.error('Informe a quantidade.');
    const { error } = await supabase.from('stock_movements').insert({ product_id: product.id, type, quantity: value, note: note.trim() || null });
    if (error) return toast.error(error);
    onSaved();
  }
  return (
    <Modal title={`${type === 'entrada' ? 'Entrada' : 'Saída'} · ${product.name}`} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancelar</button><button type="button" className="btn btn-primary" onClick={save}>Registrar</button></>}>
      <Field label={`Quantidade (${product.unit})`}><input className="input" autoFocus inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></Field>
      <Field label="Observação"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={type === 'entrada' ? 'ex.: compra, NF 123' : 'ex.: usado no procedimento'} /></Field>
      <div className="small muted">Saldo atual: {qty(product.quantity)} {product.unit}</div>
    </Modal>
  );
}

export function StockPage() {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(null);
  const [moving, setMoving] = useState(null);
  const [openId, setOpenId] = useState(null);
  const productsLoad = useLoad(() => must(supabase.from('stock_levels').select('*').eq('active', true).order('name')), []);
  const products = productsLoad.data ?? [];
  const { reload } = productsLoad;
  // Depends on the loaded data itself (stable between renders), so the
  // history refreshes after a movement without re-running on every render.
  const { data: history = [] } = useLoad(
    () => (openId ? must(supabase.from('stock_movements').select('*, author:staff(full_name)').eq('product_id', openId).order('moved_at', { ascending: false }).limit(20)) : Promise.resolve([])),
    [openId, productsLoad.data],
  );

  const shown = products.filter((p) => !query.trim() || norm(p.name).includes(norm(query.trim())) || norm(p.location).includes(norm(query.trim())));
  const low = products.filter((p) => Number(p.quantity) <= Number(p.min_quantity) && Number(p.min_quantity) > 0).length;


  async function removeMovement(m) {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Apagar esta ${m.type === 'entrada' ? 'entrada' : 'saída'} de ${qty(m.quantity)}?`)) return;
    const { error } = await supabase.from('stock_movements').delete().eq('id', m.id);
    if (error) return toast.error(error);
    reload();
  }
  return (
    <div className="page">
      <header className="topbar">
        <div>
          <h1>Estoque</h1>
          <div className="sub">{products.length} produtos{low ? ` · ${low} abaixo do mínimo` : ''}</div>
        </div>
        <div className="topbar-right">
          <div className="search"><Search /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar produto ou local" /></div>
          <button type="button" className="btn btn-primary" onClick={() => setEditing({})}><Plus /> Novo produto</button>
        </div>
      </header>
      <div className="card scroll grow">
        <table className="table">
          <thead><tr><th>Produto</th><th>Local</th><th className="num">Saldo</th><th className="num">Mínimo</th><th style={{ width: 230 }} /></tr></thead>
          <tbody>
            {shown.map((p) => {
              const isLow = Number(p.min_quantity) > 0 && Number(p.quantity) <= Number(p.min_quantity);
              return [
                <tr key={p.id} className="click" onClick={() => setOpenId(openId === p.id ? null : p.id)}>
                  <td style={{ fontWeight: 700 }}>{p.name}</td>
                  <td className="muted">{p.location}</td>
                  <td className={`num ${isLow ? 'low' : ''}`}>{qty(p.quantity)} {p.unit}</td>
                  <td className="num muted">{qty(p.min_quantity)}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div className="row">
                      <button type="button" className="btn btn-sm" onClick={() => setMoving({ product: p, type: 'entrada' })}><ArrowDownToLine /> Entrada</button>
                      <button type="button" className="btn btn-sm" onClick={() => setMoving({ product: p, type: 'saida' })}><ArrowUpFromLine /> Saída</button>
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(p)}>Editar</button>
                    </div>
                  </td>
                </tr>,
                openId === p.id && (
                  <tr key={`${p.id}-h`}>
                    <td colSpan={5} style={{ background: 'var(--surface-2)' }}>
                      {history.length === 0 && <span className="small muted">Sem movimentações.</span>}
                      {history.map((m) => (
                        <div key={m.id} className="row small" style={{ padding: '3px 0' }}>
                          <span className={m.type === 'entrada' ? 'tag ok' : 'tag warn'}>{m.type === 'entrada' ? '+' : '−'}{qty(m.quantity)}</span>
                          <span className="mono muted">{formatDateTime(m.moved_at)}</span>
                          <span>{m.note}</span>
                          <span className="muted">{m.author?.full_name}</span>
                          <span className="grow" />
                          <button type="button" className="icon-btn ghost" style={{ width: 28, height: 28 }} onClick={() => removeMovement(m)} aria-label="Apagar movimentação" title="Apagar"><Trash2 /></button>
                        </div>
                      ))}
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
        {shown.length === 0 && <Empty>Nenhum produto cadastrado.</Empty>}
      </div>
      {editing && <ProductModal product={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
      {moving && <MovementModal {...moving} onClose={() => setMoving(null)} onSaved={() => { setMoving(null); reload(); }} />}
    </div>
  );
}
