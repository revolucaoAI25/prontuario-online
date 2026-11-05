import { useState } from 'react';
import { Plus, ArrowDownToLine, ArrowUpFromLine, Search, Trash2, Tags, Pencil, Check } from 'lucide-react';
import { supabase, must } from '../lib/supabase.js';
import { useLoad } from '../lib/hooks.js';
import { useToast } from '../context/ToastContext.jsx';
import { addDays, formatDateTime, localDay, zonedToUtc } from '../lib/time.js';
import { Empty, Field, Modal } from '../components/ui.jsx';
import { usePeriod } from './finance/period.jsx';

const qty = (n) => Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const NO_SECTOR = 'sem';

function ProductModal({ product, sectors, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', unit: 'un', location: '', min_quantity: 0, notes: '', sector_id: '', ...product });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function save() {
    if (!form.name.trim()) return toast.error('Informe o nome do produto.');
    const row = {
      name: form.name.trim(), unit: form.unit.trim() || 'un', location: form.location?.trim() || null,
      min_quantity: Number(form.min_quantity) || 0, notes: form.notes?.trim() || null, sector_id: form.sector_id || null,
    };
    const { error } = product?.id
      ? await supabase.from('stock_products').update(row).eq('id', product.id)
      : await supabase.from('stock_products').insert(row);
    if (error) return toast.error(/stock_products_name_idx/.test(error.message ?? '') ? 'Já existe um produto com esse nome.' : error);
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
        <Field label="Setor">
          <select className="select" value={form.sector_id ?? ''} onChange={set('sector_id')}>
            <option value="">Sem setor</option>
            {sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Unidade"><input className="input" value={form.unit} onChange={set('unit')} placeholder="un, ml, cx" /></Field>
        <Field label="Estoque mínimo"><input className="input" type="number" min="0" value={form.min_quantity} onChange={set('min_quantity')} /></Field>
        <Field label="Local"><input className="input" value={form.location ?? ''} onChange={set('location')} placeholder="ex.: Armário da sala 2" /></Field>
        <Field label="Observações" full><input className="input" value={form.notes ?? ''} onChange={set('notes')} /></Field>
      </div>
    </Modal>
  );
}

function MovementModal({ product, type, onClose, onSaved }) {
  const toast = useToast();
  const [quantity, setQuantity] = useState('');
  const [note, setNote] = useState('');
  const [day, setDay] = useState(localDay());
  async function save() {
    const value = Number(String(quantity).replace(',', '.'));
    if (!(value > 0)) return toast.error('Informe a quantidade.');
    // Today: now. Another day: midday of that day, so it falls in that day's filter.
    const movedAt = day === localDay() ? new Date() : zonedToUtc(day, '12:00');
    const { error } = await supabase.from('stock_movements').insert({ product_id: product.id, type, quantity: value, note: note.trim() || null, moved_at: movedAt.toISOString() });
    if (error) return toast.error(error);
    onSaved();
  }
  return (
    <Modal title={`${type === 'entrada' ? 'Entrada' : 'Saída'} · ${product.name}`} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancelar</button><button type="button" className="btn btn-primary" onClick={save}>Registrar</button></>}>
      <div className="form-grid">
        <Field label={`Quantidade (${product.unit})`}><input className="input" autoFocus inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></Field>
        <Field label="Data"><input className="input" type="date" value={day} max={localDay()} onChange={(e) => e.target.value && setDay(e.target.value)} /></Field>
      </div>
      <Field label="Observação"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={type === 'entrada' ? 'ex.: compra, NF 123' : 'ex.: usado no procedimento'} /></Field>
      <div className="small muted">Saldo atual: {qty(product.quantity)} {product.unit}</div>
    </Modal>
  );
}

// Sectors are created by the clinic: estética, depilação, café, limpeza...
function SectorsModal({ sectors, onClose, onChanged }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [editing, setEditing] = useState(null);
  const duplicate = (error) => (/stock_sectors_name_idx/.test(error.message ?? '') ? 'Já existe um setor com esse nome.' : error);

  async function add() {
    if (!name.trim()) return;
    const { error } = await supabase.from('stock_sectors').insert({ name: name.trim() });
    if (error) return toast.error(duplicate(error));
    setName('');
    return onChanged();
  }
  async function rename() {
    if (!editing.name.trim()) return;
    const { error } = await supabase.from('stock_sectors').update({ name: editing.name.trim() }).eq('id', editing.id);
    if (error) return toast.error(duplicate(error));
    setEditing(null);
    return onChanged();
  }
  async function remove(sector) {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Apagar o setor "${sector.name}"? Os produtos dele ficam sem setor.`)) return;
    const { error } = await supabase.from('stock_sectors').delete().eq('id', sector.id);
    if (error) return toast.error(error);
    onChanged();
  }

  return (
    <Modal title="Setores do estoque" onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Fechar</button>}>
      <div className="row" style={{ marginBottom: 12 }}>
        <input className="input grow" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="Novo setor, ex.: Café" />
        <button type="button" className="btn btn-primary" onClick={add}><Plus /> Criar</button>
      </div>
      {sectors.length === 0 && <div className="small muted">Nenhum setor ainda. Crie o primeiro acima.</div>}
      {sectors.map((s) => (
        <div key={s.id} className="side-item row">
          {editing?.id === s.id ? (
            <>
              <input className="input grow" autoFocus value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && rename()} />
              <button type="button" className="icon-btn" onClick={rename} aria-label="Salvar"><Check /></button>
            </>
          ) : (
            <>
              <span className="grow" style={{ fontWeight: 600 }}>{s.name}</span>
              <button type="button" className="icon-btn ghost" onClick={() => setEditing({ id: s.id, name: s.name })} aria-label="Renomear" title="Renomear"><Pencil /></button>
              <button type="button" className="icon-btn ghost" onClick={() => remove(s)} aria-label="Apagar setor" title="Apagar"><Trash2 /></button>
            </>
          )}
        </div>
      ))}
    </Modal>
  );
}

export function StockPage() {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [sector, setSector] = useState('todos');
  const [editing, setEditing] = useState(null);
  const [moving, setMoving] = useState(null);
  const [managing, setManaging] = useState(false);
  const [openId, setOpenId] = useState(null);
  const { from, to, picker, label } = usePeriod('hoje');
  const productsLoad = useLoad(() => must(supabase.from('stock_levels').select('*').eq('active', true).order('name')), []);
  const products = productsLoad.data ?? [];
  const { reload } = productsLoad;
  const { data: sectors = [], reload: reloadSectors } = useLoad(() => must(supabase.from('stock_sectors').select('*').order('name')), []);
  // Entries and exits in the chosen period, per product.
  const { data: moved = {} } = useLoad(async () => {
    const rows = await must(supabase.from('stock_movements').select('product_id, type, quantity')
      .gte('moved_at', zonedToUtc(from, '00:00').toISOString()).lt('moved_at', zonedToUtc(addDays(to, 1), '00:00').toISOString()));
    const sums = {};
    for (const m of rows) {
      sums[m.product_id] ??= { entrada: 0, saida: 0 };
      sums[m.product_id][m.type] += Number(m.quantity);
    }
    return sums;
  }, [from, to, productsLoad.data]);
  // Depends on the loaded data itself (stable between renders), so the
  // history refreshes after a movement without re-running on every render.
  const { data: history = [] } = useLoad(
    () => (openId ? must(supabase.from('stock_movements').select('*, author:staff(full_name)').eq('product_id', openId).order('moved_at', { ascending: false }).limit(20)) : Promise.resolve([])),
    [openId, productsLoad.data],
  );

  const sectorName = (id) => sectors.find((s) => s.id === id)?.name;
  const shown = products.filter((p) => (!query.trim() || norm(p.name).includes(norm(query.trim())) || norm(p.location).includes(norm(query.trim())))
    && (sector === 'todos' || (sector === NO_SECTOR ? !p.sector_id : p.sector_id === sector)));
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
          <button type="button" className="btn" onClick={() => setManaging(true)}><Tags /> Setores</button>
          <button type="button" className="btn btn-primary" onClick={() => setEditing({ sector_id: sector !== 'todos' && sector !== NO_SECTOR ? sector : '' })}><Plus /> Novo produto</button>
        </div>
      </header>
      <div className="row-wrap" style={{ marginBottom: 12 }}>
        {picker}<span className="small muted">Entradas e saídas: {label}</span>
        <span className="grow" />
        <div className="agenda-chips">
          {[['todos', 'Todos'], ...sectors.map((s) => [s.id, s.name]), ...(products.some((p) => !p.sector_id) && sectors.length ? [[NO_SECTOR, 'Sem setor']] : [])].map(([id, text]) => (
            <button key={id} type="button" className={`chip ${sector === id ? 'on' : ''}`} onClick={() => setSector(id)} aria-pressed={sector === id}>{text}</button>
          ))}
        </div>
      </div>
      <div className="card scroll grow">
        <table className="table">
          <thead>
            <tr><th>Produto</th><th>Setor</th><th>Local</th><th className="num">Entradas</th><th className="num">Saídas</th><th className="num">Saldo</th><th className="num">Mínimo</th><th style={{ width: 230 }} /></tr>
          </thead>
          <tbody>
            {shown.map((p) => {
              const isLow = Number(p.min_quantity) > 0 && Number(p.quantity) <= Number(p.min_quantity);
              const m = moved[p.id] ?? { entrada: 0, saida: 0 };
              return [
                <tr key={p.id} className="click" onClick={() => setOpenId(openId === p.id ? null : p.id)}>
                  <td style={{ fontWeight: 700 }}>{p.name}</td>
                  <td>{sectorName(p.sector_id) ? <span className="tag">{sectorName(p.sector_id)}</span> : <span className="muted">—</span>}</td>
                  <td className="muted">{p.location}</td>
                  <td className="num">{m.entrada ? <span className="stock-in">+{qty(m.entrada)}</span> : <span className="muted">0</span>}</td>
                  <td className="num">{m.saida ? <span className="stock-out">−{qty(m.saida)}</span> : <span className="muted">0</span>}</td>
                  <td className={`num ${isLow ? 'low' : ''}`}><b>{qty(p.quantity)}</b> {p.unit}</td>
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
                    <td colSpan={8} style={{ background: 'var(--surface-2)' }}>
                      {history.length === 0 && <span className="small muted">Sem movimentações.</span>}
                      {history.map((h) => (
                        <div key={h.id} className="row small" style={{ padding: '3px 0' }}>
                          <span className={h.type === 'entrada' ? 'tag ok' : 'tag warn'}>{h.type === 'entrada' ? '+' : '−'}{qty(h.quantity)}</span>
                          <span className="mono muted">{formatDateTime(h.moved_at)}</span>
                          <span>{h.note}</span>
                          <span className="muted">{h.author?.full_name}</span>
                          <span className="grow" />
                          <button type="button" className="icon-btn ghost" style={{ width: 28, height: 28 }} onClick={() => removeMovement(h)} aria-label="Apagar movimentação" title="Apagar"><Trash2 /></button>
                        </div>
                      ))}
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
        {shown.length === 0 && <Empty>{products.length ? 'Nenhum produto neste setor.' : 'Nenhum produto cadastrado.'}</Empty>}
      </div>
      {editing && <ProductModal product={editing} sectors={sectors} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
      {moving && <MovementModal {...moving} onClose={() => setMoving(null)} onSaved={() => { setMoving(null); reload(); }} />}
      {managing && <SectorsModal sectors={sectors} onClose={() => setManaging(false)} onChanged={() => { reloadSectors(); reload(); }} />}
    </div>
  );
}
