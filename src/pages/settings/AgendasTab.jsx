import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { supabase, must } from '../../lib/supabase.js';
import { useLoad } from '../../lib/hooks.js';
import { useToast } from '../../context/ToastContext.jsx';
import { Field } from '../../components/ui.jsx';
import { formatDateTime } from '../../lib/time.js';

const WEEKDAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const hhmm = (t) => String(t ?? '').slice(0, 5);

function parseTimes(text) {
  const times = String(text).split(/[\s,;]+/).filter(Boolean).map((t) => {
    const m = t.match(/^(\d{1,2})(?:[:h](\d{2}))?$/);
    if (!m || Number(m[1]) > 23 || Number(m[2] ?? 0) > 59) throw new Error(`Horário inválido: ${t}`);
    return `${m[1].padStart(2, '0')}:${m[2] ?? '00'}`;
  });
  return [...new Set(times)].sort();
}

function AgendaEditor({ agenda, onSaved }) {
  const toast = useToast();
  const [info, setInfo] = useState(agenda);
  const [types, setTypes] = useState([]);
  const [hours, setHours] = useState([]);
  const [fixed, setFixed] = useState({});

  useEffect(() => {
    setInfo(agenda);
    setTypes(agenda.appointment_types.filter((t) => t.active).sort((a, b) => a.sort_order - b.sort_order));
    setHours(agenda.agenda_hours.map((h) => ({ ...h, start_time: hhmm(h.start_time), end_time: hhmm(h.end_time) })));
    const byDay = {};
    for (const s of agenda.agenda_slot_times) (byDay[s.weekday] ??= []).push(hhmm(s.start_time));
    setFixed(Object.fromEntries(Object.entries(byDay).map(([d, list]) => [d, list.sort().join(' ')])));
  }, [agenda]);

  async function remove() {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Apagar a agenda "${agenda.name}"?`)) return;
    const { data, error } = await supabase.rpc('delete_agenda', { p_id: agenda.id });
    if (error) return toast.error(error);
    toast.info(data === 'arquivado'
      ? `"${agenda.name}" tem atendimentos no histórico: saiu da agenda e dos ajustes, mas o histórico continua.`
      : `Agenda "${agenda.name}" apagada.`);
    onSaved();
  }

  async function save() {
    try {
      await must(supabase.from('agendas').update({ name: info.name, color: info.color, slot_step_minutes: Number(info.slot_step_minutes) || 30 }).eq('id', agenda.id));

      const keepTypes = types.filter((t) => t.id).map((t) => t.id);
      const removed = agenda.appointment_types.filter((t) => t.active && !keepTypes.includes(t.id)).map((t) => t.id);
      if (removed.length) await must(supabase.from('appointment_types').update({ active: false, is_default: false }).in('id', removed));
      await must(supabase.from('appointment_types').update({ is_default: false }).eq('agenda_id', agenda.id));
      for (const [i, t] of types.entries()) {
        const row = { agenda_id: agenda.id, name: t.name.trim(), duration_minutes: Number(t.duration_minutes) || 30, is_default: Boolean(t.is_default), active: true, sort_order: i };
        if (!row.name) continue;
        if (t.id) await must(supabase.from('appointment_types').update(row).eq('id', t.id));
        else await must(supabase.from('appointment_types').insert(row));
      }

      for (const h of hours) {
        if (!h.start_time || !h.end_time || h.end_time <= h.start_time) throw new Error(`Horário inválido na ${WEEKDAYS[h.weekday]}.`);
      }
      await must(supabase.from('agenda_hours').delete().eq('agenda_id', agenda.id));
      if (hours.length) await must(supabase.from('agenda_hours').insert(hours.map((h) => ({ agenda_id: agenda.id, weekday: h.weekday, start_time: h.start_time, end_time: h.end_time }))));

      const slots = Object.entries(fixed).flatMap(([weekday, text]) => parseTimes(text).map((t) => ({ agenda_id: agenda.id, weekday: Number(weekday), start_time: t })));
      await must(supabase.from('agenda_slot_times').delete().eq('agenda_id', agenda.id));
      if (slots.length) await must(supabase.from('agenda_slot_times').insert(slots));

      toast.info(`${info.name} salva.`);
      onSaved();
    } catch (error) {
      toast.error(error);
    }
  }

  return (
    <div className="card card-pad" style={{ marginBottom: 14 }}>
      <div className="form-grid" style={{ gridTemplateColumns: '2fr 1fr 1fr' }}>
        <Field label="Nome"><input className="input" value={info.name} onChange={(e) => setInfo({ ...info, name: e.target.value })} /></Field>
        <Field label="Cor"><input className="input" type="color" value={info.color} onChange={(e) => setInfo({ ...info, color: e.target.value })} style={{ height: 36 }} /></Field>
        <Field label="Intervalo da grade (min)" hint="Usado nos dias sem horários fixos.">
          <input className="input" type="number" min="5" max="240" value={info.slot_step_minutes} onChange={(e) => setInfo({ ...info, slot_step_minutes: e.target.value })} />
        </Field>
      </div>

      <div className="section-title" style={{ marginTop: 6 }}>Tipos de atendimento</div>
      {types.map((t, i) => (
        <div key={t.id ?? `n${i}`} className="row" style={{ marginBottom: 6 }}>
          <input className="input" value={t.name} placeholder="Nome" onChange={(e) => setTypes(types.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
          <input className="input" type="number" min="5" style={{ width: 90 }} value={t.duration_minutes} onChange={(e) => setTypes(types.map((x, j) => (j === i ? { ...x, duration_minutes: e.target.value } : x)))} />
          <span className="small muted">min</span>
          <label className="check small"><input type="radio" name={`default-${agenda.id}`} checked={Boolean(t.is_default)} onChange={() => setTypes(types.map((x, j) => ({ ...x, is_default: j === i })))} /> padrão</label>
          <button type="button" className="icon-btn" onClick={() => setTypes(types.filter((_, j) => j !== i))} aria-label="Remover tipo"><Trash2 /></button>
        </div>
      ))}
      <button type="button" className="btn btn-sm" onClick={() => setTypes([...types, { name: '', duration_minutes: 30, is_default: types.length === 0 }])}><Plus /> Tipo</button>

      <div className="section-title" style={{ marginTop: 16 }}>Horário de atendimento</div>
      <table className="table" style={{ marginBottom: 10 }}>
        <thead><tr><th style={{ width: 110 }}>Dia</th><th>Períodos</th><th>Horários fixos (opcional)</th></tr></thead>
        <tbody>
          {WEEKDAYS.map((label, weekday) => (
            <tr key={weekday}>
              <td style={{ fontWeight: 700 }}>{label}</td>
              <td>
                {hours.map((h, i) => (h.weekday !== weekday ? null : (
                  <div key={i} className="row" style={{ marginBottom: 4 }}>
                    <input className="input" type="time" style={{ width: 110 }} value={h.start_time} onChange={(e) => setHours(hours.map((x, j) => (j === i ? { ...x, start_time: e.target.value } : x)))} />
                    <span className="muted">às</span>
                    <input className="input" type="time" style={{ width: 110 }} value={h.end_time} onChange={(e) => setHours(hours.map((x, j) => (j === i ? { ...x, end_time: e.target.value } : x)))} />
                    <button type="button" className="icon-btn" onClick={() => setHours(hours.filter((_, j) => j !== i))} aria-label="Remover período"><Trash2 /></button>
                  </div>
                )))}
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setHours([...hours, { weekday, start_time: '08:00', end_time: '12:00' }])}><Plus /> período</button>
              </td>
              <td>
                <input className="input" value={fixed[weekday] ?? ''} placeholder="ex.: 13:30 14:00 14:40" onChange={(e) => setFixed({ ...fixed, [weekday]: e.target.value })} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="small muted" style={{ marginBottom: 10 }}>
        Com horários fixos, a API oferece exatamente esses horários e cada um dura até o próximo. Sem eles, a grade anda pelo intervalo acima.
      </div>
      <div className="row">
        <button type="button" className="btn btn-primary" onClick={save}>Salvar {info.name}</button>
        <span className="grow" />
        <button type="button" className="btn btn-ghost" style={{ color: 'var(--danger)' }} onClick={remove}><Trash2 /> Apagar agenda</button>
      </div>
    </div>
  );
}

function UpcomingBlocks() {
  const toast = useToast();
  const { data: blocks = [], reload } = useLoad(
    () => must(supabase.from('agenda_blocks').select('*, agenda:agendas(name)').gte('ends_at', new Date().toISOString()).order('starts_at').limit(100)),
    [],
  );
  async function remove(id) {
    const { error } = await supabase.from('agenda_blocks').delete().eq('id', id);
    if (error) return toast.error(error);
    reload();
  }
  return (
    <div className="card card-pad">
      <div className="section-title">Bloqueios futuros</div>
      {blocks.length === 0 && <div className="small muted">Nenhum. Bloqueie horários pela tela da Agenda.</div>}
      {blocks.map((b) => (
        <div key={b.id} className="side-item row">
          <span className="mono">{formatDateTime(b.starts_at)} – {formatDateTime(b.ends_at)}</span>
          <span><b>{b.agenda?.name ?? 'Clínica inteira'}</b>{b.reason ? ` · ${b.reason}` : ''}</span>
          <span className="grow" />
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => remove(b.id)}>Remover</button>
        </div>
      ))}
    </div>
  );
}

export function AgendasTab() {
  const toast = useToast();
  const { data: agendas = [], reload } = useLoad(
    () => must(supabase.from('agendas').select('*, appointment_types(*), agenda_hours(*), agenda_slot_times(*)').eq('active', true).order('sort_order')),
    [],
  );
  async function addAgenda() {
    // eslint-disable-next-line no-alert
    const name = window.prompt('Nome da nova agenda:');
    if (!name?.trim()) return;
    const { data, error } = await supabase.from('agendas').insert({ name: name.trim(), sort_order: agendas.length + 1 }).select().single();
    if (error) return toast.error(error);
    await supabase.from('appointment_types').insert({ agenda_id: data.id, name: 'Consulta', duration_minutes: 30, is_default: true });
    reload();
  }
  return (
    <div>
      {agendas.map((a) => (
        <AgendaEditor key={a.id} agenda={a} onSaved={reload} />
      ))}
      <button type="button" className="btn" onClick={addAgenda} style={{ marginBottom: 14 }}><Plus /> Nova agenda</button>
      <UpcomingBlocks />
    </div>
  );
}
