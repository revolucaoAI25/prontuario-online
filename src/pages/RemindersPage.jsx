import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Cake, X, RotateCcw, BellRing, Trash2, ListChecks } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { ProceduresTab } from './settings/ProceduresTab.jsx';
import { supabase, must } from '../lib/supabase.js';
import { useLoad } from '../lib/hooks.js';
import { useToast } from '../context/ToastContext.jsx';
import { addDays, ageFrom, formatDay, localDay } from '../lib/time.js';
import { Empty, Field, Modal } from '../components/ui.jsx';
import { PatientPicker } from '../components/PatientPicker.jsx';
import { loadProcedures } from '../components/ProcedurePicker.jsx';

const TABS = [
  { id: 'proximos', label: 'Próximos 30 dias', status: 'pendente', empty: 'Nenhum retorno previsto para os próximos 30 dias. Veja todos em “Todos pendentes”.' },
  { id: 'pendentes', label: 'Todos pendentes', status: 'pendente', empty: 'Nenhum lembrete pendente. Eles são criados quando o paciente chega para um procedimento.' },
  { id: 'enviado', label: 'Enviados', status: 'enviado', empty: 'Nenhum lembrete enviado ainda.' },
  { id: 'expirado', label: 'Vencidos (não enviados)', status: 'expirado', empty: 'Nenhum lembrete vencido.' },
  { id: 'erro', label: 'Com erro', status: 'erro', empty: 'Nenhum envio com erro.' },
  { id: 'cancelado', label: 'Cancelados', status: 'cancelado', empty: 'Nenhum lembrete cancelado.' },
];

async function countReminders() {
  const head = (build) => build(supabase.from('reminders').select('id', { count: 'exact', head: true })).then((r) => r.count ?? 0);
  const today = localDay();
  const [proximos, pendentes, enviado, expirado, erro, cancelado] = await Promise.all([
    head((q) => q.eq('status', 'pendente').gte('due_on', addDays(today, -30)).lte('due_on', addDays(today, 30))),
    head((q) => q.eq('status', 'pendente')),
    head((q) => q.eq('status', 'enviado')),
    head((q) => q.eq('status', 'expirado')),
    head((q) => q.eq('status', 'erro')),
    head((q) => q.eq('status', 'cancelado')),
  ]);
  return { proximos, pendentes, enviado, expirado, erro, cancelado };
}

function NewReminder({ onClose, onSaved }) {
  const toast = useToast();
  const [patient, setPatient] = useState(null);
  const { data: procedures = [] } = useLoad(() => loadProcedures(), []);
  const [procedureId, setProcedureId] = useState('');
  const [due, setDue] = useState(addDays(localDay(), 30));

  async function save() {
    if (!patient || patient.isNew) return toast.error('Escolha um paciente cadastrado.');
    if (!procedureId) return toast.error('Escolha o procedimento.');
    const { error } = await supabase.from('reminders').insert({
      patient_id: patient.id, procedure_id: procedureId, due_on: due, manual_due: true, created_manually: true,
    });
    if (error) return toast.error(/one_pending/.test(error.message) ? 'Esse paciente já tem um lembrete pendente desse procedimento.' : error);
    onSaved();
  }

  return (
    <Modal title="Novo lembrete" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancelar</button><button type="button" className="btn btn-primary" onClick={save}>Criar</button></>}>
      <Field label="Paciente"><PatientPicker value={patient} onChange={setPatient} autoFocus /></Field>
      <Field label="Procedimento">
        <select className="select" value={procedureId} onChange={(e) => setProcedureId(e.target.value)}>
          <option value="">Escolha…</option>
          {procedures.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </Field>
      <Field label="Enviar em"><input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
    </Modal>
  );
}

export function RemindersPage() {
  const toast = useToast();
  const { isAdmin } = useAuth();
  const [types, setTypes] = useState(false);
  const [tab, setTab] = useState('proximos');
  const [creating, setCreating] = useState(false);
  const status = TABS.find((t) => t.id === tab).status;

  const { data: reminders = [], reload } = useLoad(() => {
    let q = supabase
      .from('reminders')
      .select('*, patient:patients(id, full_name, phone, allow_messages), procedure:procedures(name)')
      .eq('status', status)
      .order(status === 'pendente' ? 'due_on' : 'updated_at', { ascending: status === 'pendente' })
      .limit(500);
    if (tab === 'proximos') q = q.gte('due_on', addDays(localDay(), -30)).lte('due_on', addDays(localDay(), 30));
    return must(q);
  }, [tab]);
  const { data: counts = {}, reload: reloadCounts } = useLoad(countReminders, []);
  const { data: birthdays = [] } = useLoad(() => must(supabase.rpc('birthdays_on')), []);
  const { data: procedures = [] } = useLoad(() => loadProcedures(), []);

  async function update(id, changes) {
    const { error } = await supabase.from('reminders').update(changes).eq('id', id);
    if (error) return toast.error(/one_pending/.test(error.message) ? 'Já existe outro lembrete pendente desse procedimento.' : error);
    reload();
    reloadCounts();
  }

  async function remove(r) {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Apagar o lembrete de ${r.procedure?.name ?? 'retorno'} de ${r.patient?.full_name}?`)) return;
    const { error } = await supabase.from('reminders').delete().eq('id', r.id);
    if (error) return toast.error(error);
    reload();
    reloadCounts();
  }

  const today = localDay();

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <h1>Lembretes</h1>
          <div className="sub">Retorno por procedimento: contado a partir do último atendimento em que o paciente chegou</div>
        </div>
        <div className="topbar-right">
          {isAdmin && <button type="button" className="btn" onClick={() => setTypes(true)}><ListChecks /> Tipos de retorno</button>}
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}><Plus /> Novo lembrete</button>
        </div>
      </header>

      <div className="scroll grow">
        {birthdays.length > 0 && (
          <div className="card card-pad" style={{ marginBottom: 14 }}>
            <div className="section-title"><Cake size={13} /> Aniversariantes de hoje</div>
            <div className="row-wrap">
              {birthdays.map((p) => (
                <Link key={p.id} to={`/prontuario/${p.id}`} className="pill">{p.full_name} · {ageFrom(p.birth_date)} anos</Link>
              ))}
            </div>
          </div>
        )}

        <div className="card">
          <div className="tabs" style={{ padding: '0 10px', marginBottom: 0 }}>
            {TABS.map((t) => (
              <button key={t.id} type="button" className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
                {t.label}{counts[t.id] ? <span className="tab-count">{counts[t.id]}</span> : null}
              </button>
            ))}
          </div>
          <table className="table">
            <thead><tr><th>Paciente</th><th>Procedimento</th><th>Último atendimento</th><th>{status === 'pendente' ? 'Enviar em' : 'Data'}</th><th style={{ width: 160 }} /></tr></thead>
            <tbody>
              {reminders.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to={`/prontuario/${r.patient?.id}`} style={{ fontWeight: 700 }}>{r.patient?.full_name}</Link>
                    {!r.patient?.phone && <span className="tag warn" style={{ marginLeft: 6 }}>sem telefone</span>}
                    {r.patient && !r.patient.allow_messages && <span className="tag" style={{ marginLeft: 6 }}>não recebe mensagens</span>}
                  </td>
                  <td>
                    {status === 'pendente' ? (
                      <select className="select" style={{ width: 230 }} value={r.procedure_id} onChange={(e) => update(r.id, { procedure_id: e.target.value, manual_due: true })} aria-label="Procedimento">
                        {procedures.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    ) : r.procedure?.name}
                  </td>
                  <td className="mono">{r.last_done_at ? formatDay(localDay(r.last_done_at)) : '—'}</td>
                  <td>
                    {status === 'pendente' ? (
                      <div className="row">
                        <input className="input" type="date" style={{ width: 150 }} value={r.due_on} onChange={(e) => e.target.value && update(r.id, { due_on: e.target.value, manual_due: true })} aria-label="Data do lembrete" />
                        {r.due_on < today && <span className="tag danger">atrasado</span>}
                        {r.manual_due && <span className="tag">manual</span>}
                      </div>
                    ) : (
                      <span className="mono">{formatDay(r.sent_at ? localDay(r.sent_at) : r.due_on)}</span>
                    )}
                    {r.last_error && <div className="small" style={{ color: 'var(--danger)' }}>{r.last_error}</div>}
                  </td>
                  <td>
                    <div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                    {status === 'pendente' && (
                      <button type="button" className="btn btn-sm btn-ghost" style={{ color: 'var(--danger)' }} onClick={() => update(r.id, { status: 'cancelado', closed_reason: 'manual' })}><X /> Não enviar</button>
                    )}
                    {['expirado', 'cancelado', 'erro'].includes(status) && (
                      <button type="button" className="btn btn-sm" onClick={() => update(r.id, { status: 'pendente', closed_reason: null, due_on: today < r.due_on ? r.due_on : today, attempts: 0, next_attempt_at: null, last_error: null, manual_due: true })}>
                        <RotateCcw /> Reativar
                      </button>
                    )}
                    {isAdmin && (
                      <button type="button" className="icon-btn ghost" onClick={() => remove(r)} aria-label="Apagar lembrete" title="Apagar"><Trash2 /></button>
                    )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {reminders.length === 0 && <Empty icon={BellRing}>{TABS.find((t) => t.id === tab).empty}</Empty>}
        </div>
      </div>
      {types && (
        <Modal title="Tipos de retorno" wide onClose={() => { setTypes(false); reload(); }}>
          <div className="small muted" style={{ marginBottom: 12 }}>Cada procedimento é um tipo de lembrete, com o seu prazo de retorno.</div>
          <ProceduresTab />
        </Modal>
      )}
      {creating && <NewReminder onClose={() => setCreating(false)} onSaved={() => { setCreating(false); reload(); reloadCounts(); }} />}
    </div>
  );
}
