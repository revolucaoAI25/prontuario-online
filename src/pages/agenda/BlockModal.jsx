import { useState } from 'react';
import { supabase } from '../../lib/supabase.js';
import { useToast } from '../../context/ToastContext.jsx';
import { Modal, Field } from '../../components/ui.jsx';
import { addDays, timeToMinutes, zonedToUtc } from '../../lib/time.js';

// Close an agenda (or the whole clinic) for part of a day or the whole day.
export function BlockModal({ agendas, day, onClose, onSaved }) {
  const toast = useToast();
  const [agendaId, setAgendaId] = useState(agendas[0]?.id ?? '');
  const [date, setDate] = useState(day);
  const [wholeDay, setWholeDay] = useState(true);
  const [from, setFrom] = useState('12:00');
  const [to, setTo] = useState('14:00');
  const [reason, setReason] = useState('');

  async function save() {
    if (!wholeDay && timeToMinutes(to) <= timeToMinutes(from)) return toast.error('O fim precisa ser depois do início.');
    const { error } = await supabase.from('agenda_blocks').insert({
      agenda_id: agendaId || null,
      starts_at: zonedToUtc(date, wholeDay ? '00:00' : from).toISOString(),
      ends_at: wholeDay ? zonedToUtc(addDays(date, 1), '00:00').toISOString() : zonedToUtc(date, to).toISOString(),
      reason: reason.trim() || null,
    });
    if (error) return toast.error(error);
    toast.info('Horário bloqueado.');
    onSaved();
  }

  return (
    <Modal
      title="Bloquear horário"
      onClose={onClose}
      footer={<>
        <button type="button" className="btn" onClick={onClose}>Cancelar</button>
        <button type="button" className="btn btn-primary" onClick={save}>Bloquear</button>
      </>}
    >
      <Field label="Agenda">
        <select className="select" value={agendaId} onChange={(e) => setAgendaId(e.target.value)}>
          {agendas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          <option value="">Clínica inteira (todas as agendas)</option>
        </select>
      </Field>
      <Field label="Data"><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      <label className="check" style={{ marginBottom: 10 }}>
        <input type="checkbox" checked={wholeDay} onChange={(e) => setWholeDay(e.target.checked)} /> Dia inteiro
      </label>
      {!wholeDay && (
        <div className="form-grid">
          <Field label="De"><input className="input" type="time" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="Até"><input className="input" type="time" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
      )}
      <Field label="Motivo"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="ex.: Congresso, feriado" /></Field>
    </Modal>
  );
}
