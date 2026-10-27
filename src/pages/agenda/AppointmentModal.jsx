import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase.js';
import { useToast } from '../../context/ToastContext.jsx';
import { Modal, Field } from '../../components/ui.jsx';
import { PatientPicker, ensurePatient } from '../../components/PatientPicker.jsx';
import { ProcedurePicker } from '../../components/ProcedurePicker.jsx';
import { minutesToTime, timeToMinutes, zonedToUtc } from '../../lib/time.js';
import { activeTypes, defaultEndMinutes, defaultType, findOverlaps, setAppointmentProcedures } from './agendaData.js';

// New booking from the screen. Unlike the API, it may overlap other bookings
// (encaixe) after a confirmation.
export function AppointmentModal({ agendas, prefill, onClose, onSaved }) {
  const toast = useToast();
  const [patient, setPatient] = useState(prefill.patient ?? null);
  const [agendaId, setAgendaId] = useState(prefill.agendaId ?? agendas[0]?.id);
  const agenda = agendas.find((a) => a.id === agendaId);
  const [typeId, setTypeId] = useState(() => defaultType(agenda)?.id ?? '');
  const [day, setDay] = useState(prefill.day);
  const [start, setStart] = useState(prefill.time ?? '09:00');
  const [end, setEnd] = useState('');
  const [endTouched, setEndTouched] = useState(false);
  const [procedures, setProcedures] = useState([]);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [overlaps, setOverlaps] = useState(null);

  const type = agenda?.appointment_types?.find((t) => t.id === typeId);

  useEffect(() => {
    if (!agenda?.appointment_types?.some((t) => t.id === typeId)) setTypeId(defaultType(agenda)?.id ?? '');
  }, [agendaId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (endTouched || !start) return;
    const duration = type?.duration_minutes ?? 30;
    setEnd(minutesToTime(Math.min(defaultEndMinutes(agenda, day, timeToMinutes(start), duration), 24 * 60 - 1)));
  }, [start, typeId, agendaId, day, endTouched]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(force = false) {
    if (!start || !end || timeToMinutes(end) <= timeToMinutes(start)) return toast.error('O horário de término precisa ser depois do início.');
    setSaving(true);
    try {
      const startsAt = zonedToUtc(day, start).toISOString();
      const endsAt = zonedToUtc(day, end).toISOString();
      if (!force) {
        const found = await findOverlaps(agendaId, startsAt, endsAt);
        if (found.length) {
          setOverlaps(found);
          return;
        }
      }
      const patientId = await ensurePatient(patient);
      const { data, error } = await supabase
        .from('appointments')
        .insert({ agenda_id: agendaId, appointment_type_id: typeId || null, patient_id: patientId, starts_at: startsAt, ends_at: endsAt, notes: notes.trim() || null })
        .select('id')
        .single();
      if (error) throw error;
      await setAppointmentProcedures(data.id, procedures);
      toast.info('Agendamento criado.');
      onSaved(data.id);
    } catch (error) {
      toast.error(error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title="Novo agendamento"
      onClose={onClose}
      wide
      footer={overlaps ? (
        <>
          <span className="grow small" style={{ color: 'var(--warn)', fontWeight: 700 }}>
            Já existe atendimento nesse horário: {overlaps.map((o) => o.patient?.full_name).join(', ')}.
          </span>
          <button type="button" className="btn" onClick={() => setOverlaps(null)}>Voltar</button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={() => save(true)}>Encaixar mesmo assim</button>
        </>
      ) : (
        <>
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button type="button" className="btn btn-primary" disabled={saving || !patient} onClick={() => save(false)}>Agendar</button>
        </>
      )}
    >
      <Field label="Paciente">
        <PatientPicker value={patient} onChange={setPatient} autoFocus={!patient} />
      </Field>
      <div className="form-grid">
        <Field label="Agenda">
          <select className="select" value={agendaId} onChange={(e) => setAgendaId(e.target.value)}>
            {agendas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
        <Field label="Tipo">
          <select className="select" value={typeId} onChange={(e) => { setTypeId(e.target.value); setEndTouched(false); }}>
            {activeTypes(agenda).map((t) => <option key={t.id} value={t.id}>{t.name} ({t.duration_minutes} min)</option>)}
          </select>
        </Field>
        <Field label="Data"><input className="input" type="date" value={day} onChange={(e) => setDay(e.target.value)} /></Field>
        <div className="row" style={{ gap: 12 }}>
          <Field label="Início"><input className="input" type="time" step="60" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
          <Field label="Fim"><input className="input" type="time" step="60" value={end} onChange={(e) => { setEnd(e.target.value); setEndTouched(true); }} /></Field>
        </div>
        <Field label="Procedimentos" full hint="Opcional. Usado para os lembretes de retorno.">
          <ProcedurePicker value={procedures} onChange={setProcedures} />
        </Field>
        <Field label="Observação" full><input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
