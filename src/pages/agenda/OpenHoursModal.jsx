import { useState } from 'react';
import { supabase } from '../../lib/supabase.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { Modal, Field } from '../../components/ui.jsx';
import { formatDay, localDay, localMinutes, minutesToTime, timeToMinutes, zonedToUtc } from '../../lib/time.js';
import { defaultType } from './agendaData.js';

const WEEKDAYS = [[1, 'Seg'], [2, 'Ter'], [3, 'Qua'], [4, 'Qui'], [5, 'Sex'], [6, 'Sáb'], [0, 'Dom']];

// The agenda's usual gap between fixed start times (30 min, 1 h...).
function rhythmOf(agenda) {
  const count = new Map();
  for (const wd of [0, 1, 2, 3, 4, 5, 6]) {
    const times = (agenda.agenda_slot_times ?? []).filter((s) => s.weekday === wd).map((s) => timeToMinutes(s.start_time)).sort((a, b) => a - b);
    for (let i = 1; i < times.length; i += 1) {
      const gap = times[i] - times[i - 1];
      if (gap >= 10 && gap <= 120) count.set(gap, (count.get(gap) ?? 0) + 1);
    }
  }
  const best = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return best ?? defaultType(agenda)?.duration_minutes ?? 30;
}

// Open hours in an agenda. By default only on one day (an exception, the
// reverse of a block: the weekly hours stay as they are). The administrator
// can instead make it weekly, which changes the agenda's hours: the window
// joins them and, for agendas with fixed start times, the new times are added
// on the agenda's usual rhythm (closing again is in Ajustes → Agendas).
export function OpenHoursModal({ agendas, day, onClose, onSaved }) {
  const toast = useToast();
  const { isAdmin } = useAuth();
  const [mode, setMode] = useState('dia');
  const [date, setDate] = useState(day);
  const [reason, setReason] = useState('');
  const [agendaId, setAgendaId] = useState(agendas[0]?.id ?? '');
  const [days, setDays] = useState([]);
  const [from, setFrom] = useState('11:00');
  const [to, setTo] = useState('12:00');
  const [saving, setSaving] = useState(false);
  const agenda = agendas.find((a) => a.id === agendaId);
  const step = agenda ? rhythmOf(agenda) : 30;
  const usesFixed = (agenda?.agenda_slot_times ?? []).length > 0;

  const toggle = (wd) => setDays((d) => (d.includes(wd) ? d.filter((x) => x !== wd) : [...d, wd]));

  async function saveOneDay() {
    const s = timeToMinutes(from);
    const e = timeToMinutes(to);
    if (!agenda) return toast.error('Escolha a agenda.');
    if (!date) return toast.error('Escolha o dia.');
    if (e <= s) return toast.error('O fim precisa ser depois do início.');
    setSaving(true);
    const { error } = await supabase.from('agenda_openings').insert({
      agenda_id: agenda.id,
      starts_at: zonedToUtc(date, from).toISOString(),
      ends_at: zonedToUtc(date, to).toISOString(),
      reason: reason.trim() || null,
    });
    setSaving(false);
    if (error) return toast.error(error);
    toast.info(`Horário aberto só em ${formatDay(date)}. O agente de WhatsApp também pode marcar nele.`);
    return onSaved();
  }

  async function save() {
    if (mode === 'dia') return saveOneDay();
    const s = timeToMinutes(from);
    const e = timeToMinutes(to);
    if (!agenda) return toast.error('Escolha a agenda.');
    if (days.length === 0) return toast.error('Escolha pelo menos um dia da semana.');
    if (e <= s) return toast.error('O fim precisa ser depois do início.');
    setSaving(true);
    try {
      for (const wd of days) {
        // Join with the windows it touches, so the day keeps one window per stretch.
        const touching = (agenda.agenda_hours ?? []).filter((h) => h.weekday === wd
          && timeToMinutes(h.start_time) <= e && timeToMinutes(h.end_time) >= s);
        const lo = Math.min(s, ...touching.map((h) => timeToMinutes(h.start_time)));
        const hi = Math.max(e, ...touching.map((h) => timeToMinutes(h.end_time)));
        if (touching.length) {
          const { error } = await supabase.from('agenda_hours').delete().in('id', touching.map((h) => h.id));
          if (error) throw error;
        }
        const { error } = await supabase.from('agenda_hours').insert({ agenda_id: agenda.id, weekday: wd, start_time: minutesToTime(lo), end_time: minutesToTime(hi) });
        if (error) throw error;
        if (usesFixed) {
          const times = [];
          for (let m = s; m + Math.min(step, e - s) <= e; m += step) times.push(m);
          if (times.length === 0) times.push(s);
          const { error: slotError } = await supabase.from('agenda_slot_times')
            .upsert(times.map((m) => ({ agenda_id: agenda.id, weekday: wd, start_time: minutesToTime(m) })), { onConflict: 'agenda_id,weekday,start_time', ignoreDuplicates: true });
          if (slotError) throw slotError;
        }
      }
      toast.info('Horário aberto. Ele já aparece na agenda e para o agente de WhatsApp.');
      onSaved();
    } catch (error) {
      toast.error(error);
    } finally {
      setSaving(false);
    }
    return null;
  }

  // Times the WhatsApp agent will offer (same rule as available_slots in SQL).
  const duration = agenda ? (agenda.appointment_types ?? []).find((t) => t.is_default && t.active)?.duration_minutes ?? 30 : 30;
  const offerStep = mode === 'dia' ? (usesFixed ? duration : agenda?.slot_step_minutes ?? 30) : step;
  const preview = [];
  for (let m = timeToMinutes(from); m + (mode === 'dia' ? duration : 0) <= timeToMinutes(to) && m < timeToMinutes(to) && preview.length < 20; m += offerStep) preview.push(minutesToTime(m));

  return (
    <Modal title="Abrir horário" onClose={onClose}
      footer={<>
        <button type="button" className="btn" onClick={onClose}>Cancelar</button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>Abrir horário</button>
      </>}>
      <div className="seg" style={{ marginBottom: 12 }} role="tablist">
        <button type="button" role="tab" aria-selected={mode === 'dia'} className={mode === 'dia' ? 'active' : ''} onClick={() => setMode('dia')}>Só em um dia</button>
        <button type="button" role="tab" aria-selected={mode === 'semana'} className={mode === 'semana' ? 'active' : ''} disabled={!isAdmin} onClick={() => setMode('semana')}
          title={isAdmin ? '' : 'Mudar o horário fixo da agenda é com o administrador'}>Toda semana</button>
      </div>
      <div className="small muted" style={{ marginBottom: 12 }}>
        {mode === 'dia'
          ? 'Abre só nesse dia, como exceção: o horário de sempre da agenda não muda. Para desfazer, clique na etiqueta "Aberto neste dia" na agenda.'
          : 'Muda o horário da agenda: abre toda semana nos dias escolhidos. Para fechar de novo, use Ajustes → Agendas e horários; para fechar um dia só, use Bloquear horário.'}
      </div>
      <Field label="Agenda">
        <select className="select" value={agendaId} onChange={(e) => setAgendaId(e.target.value)}>
          {agendas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </Field>
      {mode === 'dia' ? (
        <Field label="Dia"><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      ) : (
        <Field label="Dias da semana">
          <div className="row-wrap">
            {WEEKDAYS.map(([wd, label]) => (
              <button key={wd} type="button" className={`chip ${days.includes(wd) ? 'on' : ''}`} onClick={() => toggle(wd)} aria-pressed={days.includes(wd)}>{label}</button>
            ))}
          </div>
        </Field>
      )}
      <div className="form-grid">
        <Field label="De"><input className="input" type="time" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="Até"><input className="input" type="time" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      {mode === 'dia' && <Field label="Motivo (opcional)"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="ex.: Encaixe, mutirão" /></Field>}
      {(usesFixed || mode === 'dia') && <div className="small muted">Horários que o agente de WhatsApp vai oferecer: {preview.join(', ') || '—'}</div>}
    </Modal>
  );
}

// Undo a one-day opening.
export function CloseOpeningModal({ opening, agendaName, onClose, onDone }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function remove() {
    setBusy(true);
    const { error } = await supabase.from('agenda_openings').delete().eq('id', opening.id);
    setBusy(false);
    if (error) return toast.error(error);
    toast.info('Horário fechado de novo.');
    return onDone();
  }
  return (
    <Modal title="Horário aberto neste dia" onClose={onClose}
      footer={<>
        <button type="button" className="btn" onClick={onClose}>Manter</button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={remove}>Fechar este horário</button>
      </>}>
      <div className="small">
        <b>{agendaName}</b> · {formatDay(localDay(opening.starts_at))}, {minutesToTime(localMinutes(opening.starts_at))}–{minutesToTime(localMinutes(opening.ends_at))}
        {opening.reason ? ` · ${opening.reason}` : ''}
      </div>
      <div className="small muted" style={{ marginTop: 8 }}>Fechar não apaga os agendamentos que já foram marcados nesse horário.</div>
    </Modal>
  );
}
