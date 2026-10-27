import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Search, UserPlus } from 'lucide-react';
import { supabase, must } from '../lib/supabase.js';
import { useDebounced, useLoad } from '../lib/hooks.js';
import { ageFrom } from '../lib/time.js';
import { Avatar, Empty } from '../components/ui.jsx';
import { PatientForm } from '../components/PatientForm.jsx';

export function PatientsPage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const q = useDebounced(query.trim(), 250);

  const { data: total } = useLoad(async () => {
    const { count } = await supabase.from('patients').select('id', { count: 'exact', head: true });
    return count;
  }, []);
  const { data: patients = [], loading } = useLoad(
    () => (q.length >= 2
      ? must(supabase.rpc('search_patients', { p_query: q, p_limit: 60 }))
      : must(supabase.from('patients').select('*').order('updated_at', { ascending: false }).limit(60))),
    [q],
  );

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <h1>Pacientes</h1>
          <div className="sub">{total != null ? `${total.toLocaleString('pt-BR')} pacientes cadastrados` : ' '}</div>
        </div>
        <div className="topbar-right">
          <div className="search">
            <Search />
            <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar por nome, telefone ou CPF" />
          </div>
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}><UserPlus /> Novo paciente</button>
        </div>
      </header>
      <div className="scroll grow">
        {!q && <div className="section-title" style={{ marginLeft: 4 }}>Atualizados recentemente</div>}
        <div className="patients-grid">
          {patients.map((p) => {
            const age = ageFrom(p.birth_date);
            return (
              <Link key={p.id} to={`/prontuario/${p.id}`} className="card patient-card">
                <Avatar name={p.full_name} />
                <div style={{ minWidth: 0 }}>
                  <div className="nm">{p.full_name}</div>
                  <div className="meta">{[age != null && `${age} anos`, p.phone].filter(Boolean).join(' · ') || 'sem telefone'}</div>
                </div>
              </Link>
            );
          })}
        </div>
        {!loading && patients.length === 0 && <Empty>Nenhum paciente encontrado.</Empty>}
      </div>
      {creating && <PatientForm onClose={() => setCreating(false)} onSaved={(p) => navigate(`/prontuario/${p.id}`)} />}
    </div>
  );
}
