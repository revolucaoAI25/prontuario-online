import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Search } from 'lucide-react';
import { supabase, must } from '../lib/supabase.js';
import { useDebounced, useLoad } from '../lib/hooks.js';
import { formatDay, localDay } from '../lib/time.js';
import { Avatar, Empty } from '../components/ui.jsx';

// Find a record by patient, or by something written in it.
export function RecordsPage() {
  const [query, setQuery] = useState('');
  const [inText, setInText] = useState(false);
  const q = useDebounced(query.trim(), 300);

  const { data: results = [] } = useLoad(
    () => (q.length >= 2 ? must(supabase.rpc('search_patients', { p_query: q, p_limit: 40, p_include_records: inText })) : Promise.resolve([])),
    [q, inText],
  );
  const { data: recent = [] } = useLoad(
    () => must(supabase.from('record_entries').select('id, entry_at, content, patient:patients(id, full_name)').order('created_at', { ascending: false }).limit(30)),
    [],
  );

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <h1>Prontuários</h1>
          <div className="sub">Busque pelo paciente ou por algo escrito no prontuário</div>
        </div>
        <div className="topbar-right">
          <div className="search" style={{ minWidth: 320 }}>
            <Search />
            <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={inText ? 'Ex.: Ultraformer, alergia…' : 'Nome, telefone ou CPF'} />
          </div>
          <label className="check"><input type="checkbox" checked={inText} onChange={(e) => setInText(e.target.checked)} /> Buscar no texto</label>
        </div>
      </header>
      <div className="card scroll grow">
        {q.length >= 2 ? (
          <>
            {results.map((p) => (
              <Link key={p.id} to={`/prontuario/${p.id}`} className="patient-card" style={{ borderBottom: '1px solid var(--border)' }}>
                <Avatar name={p.full_name} />
                <div><div className="nm">{p.full_name}</div><div className="meta">{p.phone}</div></div>
              </Link>
            ))}
            {results.length === 0 && <Empty>Nenhum resultado.</Empty>}
          </>
        ) : (
          <>
            <div className="section-title" style={{ padding: '14px 16px 0' }}>Últimos registros</div>
            {recent.map((e) => (
              <Link key={e.id} to={`/prontuario/${e.patient?.id}`} className="patient-card" style={{ borderBottom: '1px solid var(--border)', alignItems: 'flex-start' }}>
                <Avatar name={e.patient?.full_name} />
                <div style={{ minWidth: 0 }}>
                  <div className="nm">{e.patient?.full_name} <span className="small muted">· {formatDay(localDay(e.entry_at))}</span></div>
                  <div className="meta" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 700 }}>{e.content}</div>
                </div>
              </Link>
            ))}
            {recent.length === 0 && <Empty>Nenhum registro ainda.</Empty>}
          </>
        )}
      </div>
    </div>
  );
}
