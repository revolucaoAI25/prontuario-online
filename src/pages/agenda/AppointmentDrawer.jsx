import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CircleDollarSign, FileText, MessageCircle, X, Ban } from 'lucide-react';
import { supabase } from '../../lib/supabase.js';
import { useToast } from '../../context/ToastContext.jsx';
import { Avatar, Field } from '../../components/ui.jsx';
import { ProcedurePicker } from '../../components/ProcedurePicker.jsx';
import { PaymentsPanel } from '../../components/PaymentsPanel.jsx';
import { STATUSES } from '../../lib/status.js';
import { whatsappLink } from '../../lib/format.js';
import { ageFrom, formatDayLong, localDay, localTime, timeToMinutes, zonedToUtc } from '../../lib/time.js';
import { activeTypes, findOverlaps, proceduresOf, setAppointmentProcedures } from './agendaData.js';

export function AppointmentDrawer({ appointment, agendas, onClose, onChanged }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [form, setForm] = useState(null);
  const [showMoney, setShowMoney] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

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
    setShowMoney(false);
    setCancelling(false);
  }, [appointment]);

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

  const age = ageFrom(patient?.birth_date);
  const wa = whatsappLink(patient?.phone);

  return (
    <>
      <div className="overlay" onClick={onClose} />
      <aside className="drawer" aria-label="Agendamento">
        <div className="drawer-head">
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <Avatar name={patient?.full_name} size="lg" />
            <div className="grow">
              <h2 style={{ fontSize: 17 }}>{patient?.full_name}</h2>
              <div className="small muted">{[age != null && `${age} anos`, patient?.phone].filter(Boolean).join(' · ')}</div>
              <div className="row-wrap" style={{ marginTop: 8 }}>
                <span className="pill">{formatDayLong(localDay(appointment.starts_at))} · {localTime(appointment.starts_at)}</span>
                <span className="pill">{agendas.find((a) => a.id === appointment.agenda_id)?.name}</span>
              </div>
            </div>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Fechar"><X /></button>
          </div>
        </div>

        <div className="drawer-body">
          {appointment.status !== 'chegou' && appointment.status !== 'cancelado' && (
            <button type="button" className="btn btn-primary" style={{ width: '100%', marginBottom: 12 }} onClick={() => setStatus('chegou')}>
              Paciente chegou
            </button>
          )}
          <div className="section-title">Status</div>
          <div className="status-grid" style={{ marginBottom: 16 }}>
            {STATUSES.filter((s) => s.id !== 'cancelado').map((s) => (
              <button key={s.id} type="button" className={`status-btn st-${s.id} ${appointment.status === s.id ? 'sel' : ''}`} onClick={() => setStatus(s.id)}>
                <span className="dot" />{s.label}
              </button>
            ))}
          </div>
          {appointment.status === 'cancelado' && (
            <div className="banner" style={{ marginBottom: 12 }}>
              Cancelado{appointment.cancel_reason ? `: ${appointment.cancel_reason}` : ''}.{' '}
              <button type="button" className="btn btn-sm" onClick={() => setStatus('agendado', { cancel_reason: null })}>Reativar</button>
            </div>
          )}

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
            <Field label="Observação" full><input className="input" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
          </div>
          {dirty && <button type="button" className="btn btn-primary" disabled={saving} onClick={save} style={{ width: '100%' }}>Salvar alterações</button>}

          {showMoney && (
            <div className="card card-pad" style={{ marginTop: 14 }}>
              <div className="section-title">Financeiro</div>
              <PaymentsPanel patientId={appointment.patient_id} appointmentId={appointment.id} />
            </div>
          )}

          {cancelling && (
            <div className="card card-pad" style={{ marginTop: 14 }}>
              <Field label="Motivo do cancelamento (opcional)"><input className="input" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
              <div className="row">
                <button type="button" className="btn" onClick={() => setCancelling(false)}>Voltar</button>
                <button type="button" className="btn btn-danger" onClick={() => setStatus('cancelado', { cancel_reason: reason.trim() || null })}>Confirmar cancelamento</button>
              </div>
            </div>
          )}
        </div>

        <div className="drawer-foot">
          <button type="button" className="btn" onClick={() => navigate(`/prontuario/${appointment.patient_id}`)}><FileText /> Prontuário</button>
          <button type="button" className={`btn ${showMoney ? 'btn-primary' : ''}`} onClick={() => setShowMoney((v) => !v)} title="Financeiro" aria-label="Financeiro">
            <CircleDollarSign />
          </button>
          {wa && <a className="btn" href={wa} target="_blank" rel="noreferrer" title="Abrir no WhatsApp"><MessageCircle /></a>}
          <span className="grow" />
          {appointment.status !== 'cancelado' && appointment.status !== 'chegou' && (
            <button type="button" className="btn btn-danger" onClick={() => setCancelling(true)}><Ban /> Cancelar</button>
          )}
        </div>
      </aside>
    </>
  );
}
