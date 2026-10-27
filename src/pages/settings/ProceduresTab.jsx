import { useState } from 'react';
import { Plus } from 'lucide-react';
import { supabase, must } from '../../lib/supabase.js';
import { useLoad } from '../../lib/hooks.js';
import { useToast } from '../../context/ToastContext.jsx';
import { loadProcedures } from '../../components/ProcedurePicker.jsx';

export function ProceduresTab() {
  const toast = useToast();
  const [name, setName] = useState('');
  const { data: procedures = [], reload } = useLoad(() => must(supabase.from('procedures').select('*').order('name')), []);
  const { data: defaultMonths } = useLoad(async () => {
    const row = await must(supabase.from('settings').select('value').eq('key', 'default_reminder_months').maybeSingle());
    return row?.value ?? 6;
  }, []);

  async function update(id, changes) {
    const { error } = await supabase.from('procedures').update(changes).eq('id', id);
    if (error) return toast.error(error);
    loadProcedures(true);
    reload();
  }

  async function add() {
    if (!name.trim()) return;
    const { error } = await supabase.from('procedures').insert({ name: name.trim() });
    if (error) return toast.error(error);
    setName('');
    loadProcedures(true);
    reload();
  }

  return (
    <div className="card">
      <div className="banner" style={{ margin: 14 }}>
        O lembrete de retorno é enviado esse número de meses depois do último atendimento em que o paciente <b>chegou</b> com o procedimento.
        Em branco = padrão ({defaultMonths} meses, ajustável em “Lembretes e integrações”).
      </div>
      <table className="table">
        <thead><tr><th>Procedimento</th><th style={{ width: 200 }}>Retorno (meses)</th><th style={{ width: 120 }}>Ativo</th></tr></thead>
        <tbody>
          {procedures.map((p) => (
            <tr key={p.id} style={{ opacity: p.active ? 1 : 0.5 }}>
              <td style={{ fontWeight: 700 }}>{p.name}</td>
              <td>
                <input
                  className="input"
                  type="number"
                  min="1"
                  max="60"
                  style={{ width: 100 }}
                  defaultValue={p.reminder_months ?? ''}
                  placeholder={String(defaultMonths ?? 6)}
                  onBlur={(e) => {
                    const v = e.target.value === '' ? null : Number(e.target.value);
                    if (v !== p.reminder_months) update(p.id, { reminder_months: v });
                  }}
                  aria-label={`Retorno de ${p.name}`}
                />
              </td>
              <td><input type="checkbox" checked={p.active} onChange={(e) => update(p.id, { active: e.target.checked })} aria-label={`${p.name} ativo`} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row" style={{ padding: 14 }}>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Novo procedimento" onKeyDown={(e) => e.key === 'Enter' && add()} />
        <button type="button" className="btn btn-primary" onClick={add}><Plus /> Adicionar</button>
      </div>
    </div>
  );
}
