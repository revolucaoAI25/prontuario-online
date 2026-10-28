import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Ban, CircleDollarSign, FileText, MessageCircle, Trash2 } from 'lucide-react';
import { supabase, must } from '../../lib/supabase.js';
import { useLoad } from '../../lib/hooks.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { Avatar, Field, StatusPill } from '../../components/ui.jsx';
import { ProcedurePicker } from '../../components/ProcedurePicker.jsx';
import { PaymentsPanel } from '../../components/PaymentsPanel.jsx';
import { STATUSES } from '../../lib/status.js';
import { whatsappLink } from '../../lib/format.js';
import { ageFrom, formatDay, formatDayLong, localDay, localTime, timeToMinutes, zonedToUtc } from '../../lib/time.js';
import { APPOINTMENT_SELECT, activeTypes, findOverlaps, proceduresOf, setAppointmentProcedures } from './agendaData.js';

// The patient around this booking: latest record notes and other visits.
function usePatientContext(patientId) {
  return useLoad(async () => {
    const [entries, visits] = await Promise.all([
      must(supabase.from('record_entries').select('id, entry_at, content').eq('patient_id', patientId).order('entry_at', { ascending: false }).limit(3)),
      must(supabase.from('appointments').select(`${APPOINTMENT_SELECT}, agenda:agendas(name)`).eq('patient_id', patientId).order('starts_at', { ascending: false }).limit(30)),
    ]);
    return { entries, visits };
  }, [patientId]);
}

// A booking, full screen: status and editing on the left, the patient's
// context (and payments, behind the $ button) on the right.
export function AppointmentSheet({ appointment, agendas, onClose, onChanged }) {
  const toast = useToast();
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const [form, setForm] = useState(null);
  const [showMoney, setShowMoney] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const { data: context } = usePatientContext(appointment.patient_id);

  useEffect(() => {
    setForm({
      agenda_id: appointment.agenda_id,
      appointment_type_id: appointment.appointment_type_id ?? '',
      day: localDay(appointment.starts_at),
      start: localTime(appointment.starts_at),
      end: localTime(appointment.ends_at),
      notes: appointment.notes ?? '',
      procedures: proceduresOf(appointment),
    });
    setCancelling(false);
  }, [appointment]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && !document.querySelector('.modal') && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!form) return null;
  const patient = appointment.patient;
  const agenda = agendas.find((a) => a.id === form.agenda_id);
  const original = proceduresOf(appointment).map((p) => p.id).sort().join();
  const dirty =
    form.agenda_id !== appointment.agenda_id ||
    (form.appointment_type_id || null) !== (appointment.appointment_type_id ?? null) ||
    form.day !== localDay(appointment.starts_at) ||
    form.start !== localTime(appointment.starts_at) ||
    form.end !== localTime(appointment.ends_at) ||
    form.notes !== (appointment.notes ?? '') ||
    form.procedures.map((p) => p.id).sort().join() !== original;

  async function setStatus(status, extra = {}) {
    const { error } = await supabase.from('appointments').update({ status, ...extra }).eq('id', appointment.id);
    if (error) return toast.error(error);
    onChanged();
  }

  async function save() {
    if (timeToMinutes(form.end) <= timeToMinutes(form.start)) return toast.error('O horário de término precisa ser depois do início.');
    setSaving(true);
    try {
      const startsAt = zonedToUtc(form.day, form.start).toISOString();
      const endsAt = zonedToUtc(form.day, form.end).toISOString();
      const moved = startsAt !== new Date(appointment.starts_at).toISOString() || form.agenda_id !== appointment.agenda_id;
      if (moved) {
        const found = await findOverlaps(form.agenda_id, startsAt, endsAt, appointment.id);
        // eslint-disable-next-line no-alert
        if (found.length && !window.confirm(`Já existe atendimento nesse horário (${found.map((o) => o.patient?.full_name).join(', ')}). Encaixar mesmo assim?`)) return;
      }
      const typeBelongs = agenda?.appointment_types?.some((t) => t.id === form.appointment_type_id);
      const { error } = await supabase.from('appointments').update({
        agenda_id: form.agenda_id,
        appointment_type_id: typeBelongs ? form.appointment_type_id : null,
        starts_at: startsAt,
        ends_at: endsAt,
        notes: form.notes.trim() || null,
        ...(moved && appointment.status === 'pediu_remarcar' ? { status: 'agendado' } : {}),
      }).eq('id', appointment.id);
      if (error) throw error;
      await setAppointmentProcedures(appointment.id, form.procedures);
      toast.info('Agendamento atualizado.');
      onChanged();
    } catch (error) {
      toast.error(error);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Apagar este agendamento de ${patient?.full_name}? Para manter o histórico, prefira "Cancelar".`)) return;
    const { error } = await supabase.from('appointments').delete().eq('id', appointment.id);
    if (error) return toast.error(error);
    toast.info('Agendamento apagado.');
    onChanged();
    onClose();
  }

  const age = ageFrom(patient?.birth_date);
  const wa = whatsappLink(patient?.phone);
  const now = new Date();
  const others = (context?.visits ?? []).filter((v) => v.id !== appointment.id);
  const upcoming = others.filter((v) => new Date(v.starts_at) > now && v.status !== 'cancelado').reverse().slice(0, 4);
  const past = others.filter((v) => new Date(v.starts_at) <= now).slice(0, 5);

  return (
    <div className="sheet" role="dialog" aria-label="Agendamento">
      <header className="sheet-head">
        <button type="button" className="icon-btn ghost" onClick={onClose} aria-label="Voltar para a agenda" title="Voltar (Esc)"><ArrowLeft /></button>
        <Avatar name={patient?.full_name} size="lg" />
        <div className="grow" style={{ minWidth: 0 }}>
          <h2>{patient?.full_name}</h2>
          <div className="small muted">{[age != null && `${age} anos`, patient?.phone].filter(Boolean).join(' · ')}</div>
        </div>
        <div className="row-wrap">
          <button type="button" className="btn" onClick={() => navigate(`/prontuario/${appointment.patient_id}`)}><FileText /> Prontuário</button>
          {wa && <Link className="btn" to={`/conversas?paciente=${patient.id}`}><MessageCircle /> WhatsApp</Link>}
          <button type="button" className={`btn ${showMoney ? 'btn-primary' : ''}`} onClick={() => setShowMoney((v) => !v)} title="Financeiro" aria-label="Financeiro"><CircleDollarSign /></button>
        </div>
      </header>

      <div className="sheet-body">
        <section className="card card-pad sheet-main">
          <div className="row-wrap" style={{ marginBottom: 16 }}>
            <span className="pill">{formatDayLong(localDay(appointment.starts_at))} · {localTime(appointment.starts_at)}–{localTime(appointment.ends_at)}</span>
            <span className="pill"><i className="dot-sw" style={{ background: agendas.find((a) => a.id === appointment.agenda_id)?.color }} />{agendas.find((a) => a.id === appointment.agenda_id)?.name}</span>
            <StatusPill status={appointment.status} />
          </div>

          {appointment.status !== 'chegou' && appointment.status !== 'cancelado' && (
            <button type="button" className="btn btn-primary btn-lg" style={{ width: '100%', marginBottom: 16 }} onClick={() => setStatus('chegou')}>
              Paciente chegou
            </button>
          )}
          <div className="section-title">Status</div>
          <div className="status-grid wide" style={{ marginBottom: 20 }}>
            {STATUSES.filter((s) => s.id !== 'cancelado').map((s) => (
              <button key={s.id} type="button" className={`status-btn st-${s.id} ${appointment.status === s.id ? 'sel' : ''}`} onClick={() => setStatus(s.id)}>
                <span className="dot" />{s.label}
              </button>
            ))}
          </div>
          {appointment.status === 'cancelado' && (
            <div className="banner row" style={{ marginBottom: 16 }}>
              <span className="grow">Cancelado{appointment.cancel_reason ? `: ${appointment.cancel_reason}` : ''}.</span>
              <button type="button" className="btn btn-sm" onClick={() => setStatus('agendado', { cancel_reason: null })}>Reativar</button>
            </div>
          )}

          <div className="section-title">Detalhes</div>
          <div className="form-grid">
            <Field label="Agenda">
              <select className="select" value={form.agenda_id} onChange={(e) => setForm({ ...form, agenda_id: e.target.value })}>
                {agendas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
            <Field label="Tipo">
              <select className="select" value={form.appointment_type_id} onChange={(e) => setForm({ ...form, appointment_type_id: e.target.value })}>
                <option value="">—</option>
                {activeTypes(agenda).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
            <Field label="Data"><input className="input" type="date" value={form.day} onChange={(e) => setForm({ ...form, day: e.target.value })} /></Field>
            <div className="row" style={{ gap: 10 }}>
              <Field label="Início"><input className="input" type="time" step="60" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} /></Field>
              <Field label="Fim"><input className="input" type="time" step="60" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} /></Field>
            </div>
            <Field label="Procedimentos" full>
              <ProcedurePicker value={form.procedures} onChange={(procedures) => setForm({ ...form, procedures })} />
            </Field>
            <Field label="Observação" full>
              <textarea className="textarea" rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </Field>
          </div>

          <div className="sheet-actions">
            {appointment.status !== 'cancelado' && appointment.status !== 'chegou' && !cancelling && (
              <button type="button" className="btn btn-danger" onClick={() => setCancelling(true)}><Ban /> Cancelar agendamento</button>
            )}
            {isAdmin && <button type="button" className="btn btn-ghost" style={{ color: 'var(--danger)' }} onClick={remove}><Trash2 /> Apagar</button>}
            <span className="grow" />
            <button type="button" className="btn" onClick={onClose}>Fechar</button>
            <button type="button" className="btn btn-primary" disabled={!dirty || saving} onClick={save}>Salvar alterações</button>
          </div>

          {cancelling && (
            <div className="card card-pad" style={{ marginTop: 14, background: 'var(--surface-2)' }}>
              <Field label="Motivo do cancelamento (opcional)"><input className="input" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
              <div className="row">
                <button type="button" className="btn" onClick={() => setCancelling(false)}>Voltar</button>
                <button type="button" className="btn btn-danger" onClick={() => setStatus('cancelado', { cancel_reason: reason.trim() || null })}>Confirmar cancelamento</button>
              </div>
            </div>
          )}
        </section>

        <aside className="sheet-side">
          {showMoney && (
            <div className="card card-pad">
              <div className="section-title">Financeiro</div>
              <PaymentsPanel patientId={appointment.patient_id} appointmentId={appointment.id} agendaId={appointment.agenda_id} />
            </div>
          )}
          <div className="card card-pad">
            <div className="section-title">Últimos registros do prontuário</div>
            {context?.entries.length === 0 && <div className="small muted">Nenhum registro.</div>}
            {context?.entries.map((e) => (
              <div key={e.id} className="side-item">
                <div className="entry-date">{formatDay(localDay(e.entry_at))}</div>
                <div className="sheet-note">{e.content}</div>
              </div>
            ))}
          </div>
          <div className="card card-pad">
            <div className="section-title">Próximos agendamentos</div>
            {upcoming.length === 0 && <div className="small muted">Nenhum.</div>}
            {upcoming.map((v) => (
              <div key={v.id} className="side-item">
                <div className="row"><b className="tnum">{formatDay(localDay(v.starts_at))} {localTime(v.starts_at)}</b><span className="grow" /><StatusPill status={v.status} /></div>
                <div className="small muted">{v.agenda?.name}{proceduresOf(v).length ? ` · ${proceduresOf(v).map((p) => p.name).join(', ')}` : ''}</div>
              </div>
            ))}
          </div>
          <div className="card card-pad">
            <div className="section-title">Últimos atendimentos</div>
            {past.length === 0 && <div className="small muted">Nenhum.</div>}
            {past.map((v) => (
              <div key={v.id} className="side-item">
                <div className="row"><span className="tnum">{formatDay(localDay(v.starts_at))}</span><span className="grow" /><StatusPill status={v.status} /></div>
                <div className="small muted">{v.agenda?.name}{proceduresOf(v).length ? ` · ${proceduresOf(v).map((p) => p.name).join(', ')}` : ''}</div>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
