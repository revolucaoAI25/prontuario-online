import { useEffect, useState } from 'react';
import { Search, UserPlus, X } from 'lucide-react';
import { supabase } from '../lib/supabase.js';
import { useDebounced } from '../lib/hooks.js';
import { ageFrom } from '../lib/time.js';
import { Avatar } from './ui.jsx';

// Search by name/phone/CPF and pick a patient, or start a new one by name.
// `value` is either an existing patient row or { isNew: true, full_name, phone }.
export function PatientPicker({ value, onChange, autoFocus }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const debounced = useDebounced(query, 200);

  useEffect(() => {
    if (debounced.trim().length < 2) {
      setResults([]);
      return;
    }
    supabase.rpc('search_patients', { p_query: debounced, p_limit: 8 }).then(({ data }) => setResults(data ?? []));
  }, [debounced]);

  if (value && !value.isNew) {
    return (
      <div className="selected-patient">
        <Avatar name={value.full_name} />
        <div className="grow">
          <div style={{ fontWeight: 700 }}>{value.full_name}</div>
          <div className="small muted">{[value.phone, ageFrom(value.birth_date) != null && `${ageFrom(value.birth_date)} anos`].filter(Boolean).join(' · ')}</div>
        </div>
        <button type="button" className="icon-btn" onClick={() => onChange(null)} aria-label="Trocar paciente"><X /></button>
      </div>
    );
  }

  if (value?.isNew) {
    return (
      <div className="stack" style={{ gap: 0 }}>
        <div className="form-grid">
          <div className="field"><label>Nome do novo paciente</label>
            <input className="input" value={value.full_name} onChange={(e) => onChange({ ...value, full_name: e.target.value })} />
          </div>
          <div className="field"><label>Telefone</label>
            <input className="input" value={value.phone} placeholder="(31) 99999-9999" onChange={(e) => onChange({ ...value, phone: e.target.value })} />
          </div>
        </div>
        <button type="button" className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={() => onChange(null)}>Buscar paciente existente</button>
      </div>
    );
  }

  return (
    <div className="picker">
      <div className="search" style={{ minWidth: 0 }}>
        <Search />
        <input
          autoFocus={autoFocus}
          value={query}
          placeholder="Nome, telefone ou CPF"
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
        />
      </div>
      {open && query.trim().length >= 2 && (
        <div className="picker-list">
          {results.map((p) => (
            <div key={p.id} className="picker-item" onMouseDown={() => onChange(p)}>
              <Avatar name={p.full_name} />
              <div>
                <div style={{ fontWeight: 700 }}>{p.full_name}</div>
                <div className="sub">{[p.phone, p.cpf].filter(Boolean).join(' · ') || 'sem telefone'}</div>
              </div>
            </div>
          ))}
          <div
            className="picker-item"
            onMouseDown={() => onChange({ isNew: true, full_name: /\d/.test(query) ? '' : query.trim(), phone: /\d/.test(query) ? query.trim() : '' })}
          >
            <span className="avatar"><UserPlus size={15} /></span>
            <div><div style={{ fontWeight: 700 }}>Cadastrar novo paciente</div><div className="sub">“{query.trim()}”</div></div>
          </div>
        </div>
      )}
    </div>
  );
}

// Creates the patient if the picker holds a new one; returns the patient id.
export async function ensurePatient(value) {
  if (!value) throw new Error('Escolha o paciente.');
  if (!value.isNew) return value.id;
  if (!value.full_name?.trim()) throw new Error('Informe o nome do novo paciente.');
  const { data, error } = await supabase
    .from('patients')
    .insert({ full_name: value.full_name.trim(), phone: value.phone?.trim() || null })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}
