import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { supabase, must } from '../../lib/supabase.js';
import { useLoad } from '../../lib/hooks.js';
import { useToast } from '../../context/ToastContext.jsx';

// Letter buttons shown in the record composer.
export function ShortcutsTab() {
  const toast = useToast();
  const { data: shortcuts = [], reload } = useLoad(() => must(supabase.from('note_shortcuts').select('*').order('sort_order')), []);
  const [draft, setDraft] = useState({ label: '', insert_text: '', kind: 'procedimento' });

  async function update(id, changes) {
    const { error } = await supabase.from('note_shortcuts').update(changes).eq('id', id);
    if (error) return toast.error(error);
    reload();
  }
  async function remove(id) {
    const { error } = await supabase.from('note_shortcuts').delete().eq('id', id);
    if (error) return toast.error(error);
    reload();
  }
  async function add() {
    if (!draft.label.trim() || !draft.insert_text.trim()) return toast.error('Preencha a letra e o texto.');
    const { error } = await supabase.from('note_shortcuts').insert({ ...draft, label: draft.label.trim(), insert_text: draft.insert_text.trim(), sort_order: shortcuts.length + 1 });
    if (error) return toast.error(error);
    setDraft({ label: '', insert_text: '', kind: 'procedimento' });
    reload();
  }

  return (
    <div className="card">
      <table className="table">
        <thead><tr><th style={{ width: 110 }}>Botão</th><th>Texto inserido</th><th style={{ width: 170 }}>Tipo</th><th style={{ width: 100 }}>Ordem</th><th style={{ width: 60 }} /></tr></thead>
        <tbody>
          {shortcuts.map((s) => (
            <tr key={s.id}>
              <td><input className="input" defaultValue={s.label} onBlur={(e) => e.target.value !== s.label && update(s.id, { label: e.target.value.trim() })} aria-label="Botão" /></td>
              <td><input className="input" defaultValue={s.insert_text} onBlur={(e) => e.target.value !== s.insert_text && update(s.id, { insert_text: e.target.value.trim() })} aria-label="Texto" /></td>
              <td>
                <select className="select" value={s.kind} onChange={(e) => update(s.id, { kind: e.target.value })}>
                  <option value="procedimento">Procedimento</option>
                  <option value="produto">Produto</option>
                </select>
              </td>
              <td><input className="input" type="number" defaultValue={s.sort_order} onBlur={(e) => Number(e.target.value) !== s.sort_order && update(s.id, { sort_order: Number(e.target.value) })} aria-label="Ordem" /></td>
              <td><button type="button" className="icon-btn" onClick={() => remove(s.id)} aria-label="Remover"><Trash2 /></button></td>
            </tr>
          ))}
          <tr>
            <td><input className="input" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="ex.: B" /></td>
            <td><input className="input" value={draft.insert_text} onChange={(e) => setDraft({ ...draft, insert_text: e.target.value })} placeholder="ex.: Botox" /></td>
            <td>
              <select className="select" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
                <option value="procedimento">Procedimento</option>
                <option value="produto">Produto</option>
              </select>
            </td>
            <td colSpan={2}><button type="button" className="btn btn-primary btn-sm" onClick={add}><Plus /> Adicionar</button></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
