import { useEffect, useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { supabase } from '../lib/supabase.js';

let catalogCache;
export async function loadProcedures(force = false) {
  if (!catalogCache || force) {
    const { data } = await supabase.from('procedures').select('*').eq('active', true).order('name');
    catalogCache = data ?? [];
  }
  return catalogCache;
}

const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Multi-select from the registered procedures; a new name can be added and
// is registered in the catalog (with the default reminder period).
export function ProcedurePicker({ value, onChange }) {
  const [catalog, setCatalog] = useState([]);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => { loadProcedures().then(setCatalog); }, []);

  const selectedIds = new Set(value.map((p) => p.id));
  const matches = useMemo(
    () => catalog.filter((p) => !selectedIds.has(p.id) && norm(p.name).includes(norm(query.trim()))).slice(0, 12),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalog, query, value],
  );
  const exact = catalog.some((p) => norm(p.name) === norm(query.trim()));

  async function addNew() {
    const name = query.trim();
    const { data, error } = await supabase.from('procedures').insert({ name }).select().single();
    if (error) return;
    const fresh = await loadProcedures(true);
    setCatalog(fresh);
    onChange([...value, data]);
    setQuery('');
  }

  return (
    <div className="stack" style={{ gap: 6 }}>
      {value.length > 0 && (
        <div className="proc-chips">
          {value.map((p) => (
            <span key={p.id} className="proc-chip">
              {p.name}
              <button type="button" aria-label={`Remover ${p.name}`} onClick={() => onChange(value.filter((x) => x.id !== p.id))}><X size={12} /></button>
            </span>
          ))}
        </div>
      )}
      <div className="picker">
        <input
          className="input"
          value={query}
          placeholder="Adicionar procedimento (opcional)"
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
        />
        {open && (matches.length > 0 || (query.trim() && !exact)) && (
          <div className="picker-list">
            {matches.map((p) => (
              <div key={p.id} className="picker-item" onMouseDown={() => { onChange([...value, p]); setQuery(''); }}>
                <div className="grow">{p.name}</div>
                <span className="small muted">{p.reminder_months ? `retorno ${p.reminder_months}m` : 'retorno padrão'}</span>
              </div>
            ))}
            {query.trim() && !exact && (
              <div className="picker-item" onMouseDown={addNew}>
                <Plus size={15} /> Cadastrar “{query.trim()}”
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
