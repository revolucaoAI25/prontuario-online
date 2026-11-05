import { useState } from 'react';
import { CalendarRange, Pencil, Plus, Trash2, UserPlus } from 'lucide-react';
import { supabase, must } from '../lib/supabase.js';
import { useLoad } from '../lib/hooks.js';
import { useToast } from '../context/ToastContext.jsx';
import { formatDay, localDay } from '../lib/time.js';
import { Avatar, Empty, Field, Modal } from '../components/ui.jsx';

const dayCount = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

// Days of vacation inside a calendar year (a vacation may cross New Year).
function daysInYear(vacations, year) {
  return vacations.reduce((sum, v) => {
    const from = v.starts_on > `${year}-01-01` ? v.starts_on : `${year}-01-01`;
    const to = v.ends_on < `${year}-12-31` ? v.ends_on : `${year}-12-31`;
    return to >= from ? sum + dayCount(from, to) : sum;
  }, 0);
}

function EmployeeModal({ employee, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({ full_name: '', role_title: '', admission_date: '', vacation_days_per_year: 30, notes: '', ...employee });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function save() {
    if (!form.full_name.trim()) return toast.error('Informe o nome.');
    const row = {
      full_name: form.full_name.trim(), role_title: form.role_title?.trim() || null, admission_date: form.admission_date || null,
      vacation_days_per_year: Number(form.vacation_days_per_year) || 0, notes: form.notes?.trim() || null,
    };
    const { error } = employee?.id
      ? await supabase.from('employees').update(row).eq('id', employee.id)
      : await supabase.from('employees').insert(row);
    if (error) return toast.error(error);
    onSaved();
  }

  async function remove() {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Apagar ${employee.full_name} e o histórico de férias?`)) return;
    const { error } = await supabase.from('employees').delete().eq('id', employee.id);
    if (error) return toast.error(error);
    onSaved();
  }

  return (
    <Modal title={employee?.id ? 'Editar funcionário' : 'Novo funcionário'} onClose={onClose}
      footer={<>
        {employee?.id && <button type="button" className="btn btn-ghost" style={{ color: 'var(--danger)', marginRight: 'auto' }} onClick={remove}><Trash2 /> Apagar</button>}
        <button type="button" className="btn" onClick={onClose}>Cancelar</button>
        <button type="button" className="btn btn-primary" onClick={save}>Salvar</button>
      </>}>
      <div className="form-grid">
        <Field label="Nome" full><input className="input" autoFocus value={form.full_name} onChange={set('full_name')} /></Field>
        <Field label="Função"><input className="input" value={form.role_title ?? ''} onChange={set('role_title')} placeholder="ex.: Secretária, Depilação" /></Field>
        <Field label="Admissão"><input className="input" type="date" value={form.admission_date ?? ''} onChange={set('admission_date')} /></Field>
        <Field label="Dias de férias por ano"><input className="input" type="number" min="0" max="60" value={form.vacation_days_per_year} onChange={set('vacation_days_per_year')} /></Field>
        <Field label="Observações" full><textarea className="textarea" rows={2} value={form.notes ?? ''} onChange={set('notes')} /></Field>
      </div>
    </Modal>
  );
}

function VacationModal({ employee, onClose, onSaved }) {
  const toast = useToast();
  const [starts, setStarts] = useState(localDay());
  const [ends, setEnds] = useState(localDay());
  const [notes, setNotes] = useState('');
  async function save() {
    if (!starts || !ends || ends < starts) return toast.error('O fim das férias precisa ser depois do início.');
    const { error } = await supabase.from('employee_vacations').insert({ employee_id: employee.id, starts_on: starts, ends_on: ends, notes: notes.trim() || null });
    if (error) return toast.error(error);
    onSaved();
  }
  return (
    <Modal title={`Férias · ${employee.full_name}`} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancelar</button><button type="button" className="btn btn-primary" onClick={save}>Registrar</button></>}>
      <div className="form-grid">
        <Field label="De"><input className="input" type="date" value={starts} onChange={(e) => { setStarts(e.target.value); if (e.target.value > ends) setEnds(e.target.value); }} /></Field>
        <Field label="Até (último dia)"><input className="input" type="date" value={ends} min={starts} onChange={(e) => setEnds(e.target.value)} /></Field>
        <Field label="Observação" full><input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="ex.: 1ª parcela" /></Field>
      </div>
      {starts && ends >= starts && <div className="small muted">{dayCount(starts, ends)} dias</div>}
    </Modal>
  );
}

// "Pessoal": the team and their vacations. Only Dr. Everson sees it.
export function PeoplePage() {
  const toast = useToast();
  const [editing, setEditing] = useState(null);
  const [vacationFor, setVacationFor] = useState(null);
  const { data: people = [], reload } = useLoad(
    () => must(supabase.from('employees').select('*, employee_vacations(*)').order('full_name')),
    [],
  );
  const today = localDay();
  const year = Number(today.slice(0, 4));

  async function removeVacation(v) {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Apagar as férias de ${formatDay(v.starts_on)} a ${formatDay(v.ends_on)}?`)) return;
    const { error } = await supabase.from('employee_vacations').delete().eq('id', v.id);
    if (error) return toast.error(error);
    reload();
  }

  const away = people.filter((p) => p.employee_vacations.some((v) => v.starts_on <= today && v.ends_on >= today));

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <h1>Pessoal</h1>
          <div className="sub">Equipe e férias · só você vê esta área</div>
        </div>
        <div className="topbar-right">
          <button type="button" className="btn btn-primary" onClick={() => setEditing({})}><UserPlus /> Novo funcionário</button>
        </div>
      </header>
      <div className="scroll grow">
        {away.length > 0 && (
          <div className="banner info row" style={{ marginBottom: 14 }}>
            <CalendarRange size={15} /><span className="grow">De férias hoje: {away.map((p) => p.full_name).join(', ')}.</span>
          </div>
        )}
        {people.length === 0 && <Empty icon={UserPlus}>Cadastre a equipe para controlar as férias de cada um.</Empty>}
        <div className="people-grid">
          {people.map((p) => {
            const vacations = [...p.employee_vacations].sort((a, b) => b.starts_on.localeCompare(a.starts_on));
            const taken = daysInYear(vacations.filter((v) => v.starts_on <= today), year);
            const planned = vacations.filter((v) => v.starts_on > today).reverse();
            const left = Math.max(0, p.vacation_days_per_year - daysInYear(vacations, year));
            return (
              <div key={p.id} className="card card-pad person">
                <div className="row">
                  <Avatar name={p.full_name} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700 }}>{p.full_name}</div>
                    <div className="small muted">{[p.role_title, p.admission_date && `desde ${formatDay(p.admission_date)}`].filter(Boolean).join(' · ')}</div>
                  </div>
                  <button type="button" className="icon-btn ghost" onClick={() => setEditing(p)} aria-label="Editar" title="Editar"><Pencil /></button>
                </div>
                <div className="person-stats">
                  <div><b className="tnum">{taken}</b><span>dias tirados em {year}</span></div>
                  <div><b className="tnum">{left}</b><span>dias ainda livres</span></div>
                </div>
                {planned.length > 0 && <div className="small" style={{ fontWeight: 600, color: 'var(--brand-strong)' }}>Próximas: {formatDay(planned[0].starts_on)} a {formatDay(planned[0].ends_on)}</div>}
                <div className="section-title" style={{ marginTop: 10 }}>Férias</div>
                {vacations.length === 0 && <div className="small muted">Nenhuma registrada.</div>}
                {vacations.slice(0, 6).map((v) => (
                  <div key={v.id} className="side-item row">
                    <span className="grow"><span className="tnum">{formatDay(v.starts_on)} – {formatDay(v.ends_on)}</span> <span className="muted">· {dayCount(v.starts_on, v.ends_on)} dias{v.notes ? ` · ${v.notes}` : ''}</span></span>
                    <button type="button" className="icon-btn ghost" style={{ width: 28, height: 28 }} onClick={() => removeVacation(v)} aria-label="Apagar férias" title="Apagar"><Trash2 /></button>
                  </div>
                ))}
                <button type="button" className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setVacationFor(p)}><Plus /> Registrar férias</button>
              </div>
            );
          })}
        </div>
      </div>
      {editing && <EmployeeModal employee={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
      {vacationFor && <VacationModal employee={vacationFor} onClose={() => setVacationFor(null)} onSaved={() => { setVacationFor(null); reload(); }} />}
    </div>
  );
}
