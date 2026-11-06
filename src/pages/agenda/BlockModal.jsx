import { useState } from 'react';
import { supabase } from '../../lib/supabase.js';
import { useToast } from '../../context/ToastContext.jsx';
import { Modal, Field } from '../../components/ui.jsx';
import { addDays, formatDay, timeToMinutes, zonedToUtc } from '../../lib/time.js';

const MAX_DAYS = 400; // a repeating block goes up to about a year ahead

const weekdayOf = (iso) => new Date(`${iso}T12:00:00Z`).getUTCDay();

// The days a block covers: just the date, or its repetitions until "até".
export function blockDays(date, repeat, until) {
  if (repeat === 'nao') return [date];
  const days = [];
  for (let d = date, i = 0; d <= until && i < MAX_DAYS; d = addDays(d, 1), i += 1) {
    const wd = weekdayOf(d);
    if (repeat === 'semanal' && wd !== weekdayOf(date)) continue;
    if (repeat === 'uteis' && (wd === 0 || wd === 6)) continue;
    days.push(d);
  }
  return days;
}

// Close an agenda (or the whole clinic) for part of a day or the whole day,
// once or repeating (every week, every weekday or every day) until a date.
export function BlockModal({ agendas, day, onClose, onSaved }) {
  const toast = useToast();
  const [agendaId, setAgendaId] = useState(agendas[0]?.id ?? '');
  const [date, setDate] = useState(day);
  const [wholeDay, setWholeDay] = useState(true);
  const [from, setFrom] = useState('12:00');
  const [to, setTo] = useState('14:00');
  const [reason, setReason] = useState('');
  const [repeat, setRepeat] = useState('nao');
  const [until, setUntil] = useState(() => addDays(day, 90));
  const [saving, setSaving] = useState(false);

  const days = blockDays(date, repeat, until);

  async function save() {
    if (!wholeDay && timeToMinutes(to) <= timeToMinutes(from)) return toast.error('O fim precisa ser depois do início.');
    if (repeat !== 'nao' && until < date) return toast.error('A data final precisa ser depois do primeiro dia.');
    if (days.length === 0) return toast.error('Nenhum dia nesse intervalo.');
    const seriesId = repeat === 'nao' ? null : crypto.randomUUID();
    const rows = days.map((d) => ({
      agenda_id: agendaId || null,
      starts_at: zonedToUtc(d, wholeDay ? '00:00' : from).toISOString(),
      ends_at: wholeDay ? zonedToUtc(addDays(d, 1), '00:00').toISOString() : zonedToUtc(d, to).toISOString(),
      reason: reason.trim() || null,
      series_id: seriesId,
    }));
    setSaving(true);
    const { error } = await supabase.from('agenda_blocks').insert(rows);
    setSaving(false);
    if (error) return toast.error(error);
    toast.info(rows.length > 1 ? `Horário bloqueado em ${rows.length} dias.` : 'Horário bloqueado.');
    return onSaved();
  }

  return (
    <Modal
      title="Bloquear horário"
      onClose={onClose}
      footer={<>
        <button type="button" className="btn" onClick={onClose}>Cancelar</button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>Bloquear</button>
      </>}
    >
      <Field label="Agenda">
        <select className="select" value={agendaId} onChange={(e) => setAgendaId(e.target.value)}>
          {agendas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          <option value="">Clínica inteira (todas as agendas)</option>
        </select>
      </Field>
      <Field label={repeat === 'nao' ? 'Data' : 'A partir de'}><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      <label className="check" style={{ marginBottom: 10 }}>
        <input type="checkbox" checked={wholeDay} onChange={(e) => setWholeDay(e.target.checked)} /> Dia inteiro
      </label>
      {!wholeDay && (
        <div className="form-grid">
          <Field label="De"><input className="input" type="time" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="Até"><input className="input" type="time" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
      )}
      <div className="form-grid">
        <Field label="Repetir">
          <select className="select" value={repeat} onChange={(e) => setRepeat(e.target.value)}>
            <option value="nao">Não repetir</option>
            <option value="semanal">Toda semana (mesmo dia da semana)</option>
            <option value="uteis">Todo dia útil (segunda a sexta)</option>
            <option value="diario">Todos os dias</option>
          </select>
        </Field>
        {repeat !== 'nao' && (
          <Field label="Repetir até" hint={days.length ? `${days.length} ${days.length === 1 ? 'dia' : 'dias'}, até ${formatDay(days[days.length - 1])}` : 'nenhum dia'}>
            <input className="input" type="date" value={until} min={date} max={addDays(date, MAX_DAYS)} onChange={(e) => setUntil(e.target.value)} />
          </Field>
        )}
      </div>
      <Field label="Motivo"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="ex.: Almoço, congresso, feriado" /></Field>
    </Modal>
  );
}

// Unblock one day, or that day and the next ones of a repeating block.
export function UnblockModal({ block, onClose, onDone }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function remove(all) {
    setBusy(true);
    const query = supabase.from('agenda_blocks').delete();
    const { error } = all
      ? await query.eq('series_id', block.series_id).gte('starts_at', block.starts_at)
      : await query.eq('id', block.id);
    setBusy(false);
    if (error) return toast.error(error);
    toast.info(all ? 'Bloqueio removido deste dia em diante.' : 'Horário desbloqueado.');
    return onDone();
  }

  return (
    <Modal title="Desbloquear horário" onClose={onClose}
      footer={<>
        <button type="button" className="btn" onClick={onClose}>Cancelar</button>
        {block.series_id && <button type="button" className="btn" disabled={busy} onClick={() => remove(true)}>Este e os próximos</button>}
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => remove(false)}>{block.series_id ? 'Só este dia' : 'Desbloquear'}</button>
      </>}>
      <div className="small">
        {block.reason ? <b>{block.reason}</b> : 'Horário bloqueado'}
        {block.series_id ? ' · este bloqueio se repete. Desbloquear só este dia, ou este e todos os próximos?' : ' · desbloquear?'}
      </div>
    </Modal>
  );
}
