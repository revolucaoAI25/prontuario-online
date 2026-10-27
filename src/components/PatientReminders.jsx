import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { supabase, must } from '../lib/supabase.js';
import { useLoad } from '../lib/hooks.js';
import { useToast } from '../context/ToastContext.jsx';
import { addDays, localDay } from '../lib/time.js';
import { loadProcedures } from './ProcedurePicker.jsx';

// The patient's pending return reminders, editable in place: change the date,
// stop one, or add a new one from the procedure list.
export function PatientReminders({ patientId }) {
  const toast = useToast();
  const { data: reminders = [], reload } = useLoad(
    () => must(supabase.from('reminders').select('*, procedure:procedures(name)').eq('patient_id', patientId).eq('status', 'pendente').order('due_on')),
    [patientId],
  );
  const { data: procedures = [] } = useLoad(() => loadProcedures(), []);
  const [adding, setAdding] = useState(false);
  const [procedureId, setProcedureId] = useState('');
  const [due, setDue] = useState(addDays(localDay(), 30));

  const explain = (error) => (/one_pending/.test(error.message) ? 'Já existe um lembrete pendente desse procedimento.' : error);

  async function update(id, changes) {
    const { error } = await supabase.from('reminders').update(changes).eq('id', id);
    if (error) return toast.error(explain(error));
    reload();
  }

  async function add() {
    if (!procedureId) return toast.error('Escolha o procedimento.');
    const { error } = await supabase.from('reminders').insert({
      patient_id: patientId, procedure_id: procedureId, due_on: due, manual_due: true, created_manually: true,
    });
    if (error) return toast.error(explain(error));
    setAdding(false);
    setProcedureId('');
    reload();
  }

  return (
    <div className="card card-pad">
      <div className="row" style={{ marginBottom: 8 }}>
        <div className="section-title grow" style={{ margin: 0 }}>Lembretes de retorno</div>
        {!adding && <button type="button" className="btn btn-sm" onClick={() => setAdding(true)}><Plus /> Lembrete</button>}
      </div>
      {adding && (
        <div className="stack" style={{ gap: 6, marginBottom: 10 }}>
          <select className="select" value={procedureId} onChange={(e) => setProcedureId(e.target.value)} aria-label="Procedimento do lembrete">
            <option value="">Procedimento…</option>
            {procedures.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <div className="row">
            <input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Data do lembrete" />
            <button type="button" className="btn btn-sm" onClick={() => setAdding(false)}>Cancelar</button>
            <button type="button" className="btn btn-sm btn-primary" onClick={add}>Criar</button>
          </div>
        </div>
      )}
      {reminders.length === 0 && !adding && <div className="small muted">Nenhum pendente.</div>}
      {reminders.map((r) => (
        <div key={r.id} className="side-item row">
          <span className="grow">{r.procedure?.name}</span>
          <input className="input" type="date" style={{ width: 140 }} value={r.due_on}
            onChange={(e) => e.target.value && update(r.id, { due_on: e.target.value, manual_due: true })} aria-label={`Data do lembrete de ${r.procedure?.name}`} />
          <button type="button" className="icon-btn" title="Não enviar" aria-label={`Não enviar lembrete de ${r.procedure?.name}`}
            onClick={() => update(r.id, { status: 'cancelado', closed_reason: 'manual' })}><X /></button>
        </div>
      ))}
    </div>
  );
}
