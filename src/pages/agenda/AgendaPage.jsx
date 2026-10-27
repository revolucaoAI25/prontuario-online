import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Plus, Lock } from 'lucide-react';
import { supabase } from '../../lib/supabase.js';
import { useLoad, useInterval } from '../../lib/hooks.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { STATUSES } from '../../lib/status.js';
import { StatusPill } from '../../components/ui.jsx';
import { addDays, formatFullDate, formatWeekday, localDay, localTime, minutesToTime, relativeDayLabel, zonedToUtc } from '../../lib/time.js';
import { DayGrid } from './DayGrid.jsx';
import { AppointmentDrawer } from './AppointmentDrawer.jsx';
import { AppointmentModal } from './AppointmentModal.jsx';
import { BlockModal } from './BlockModal.jsx';
import { defaultType, loadAgendas, loadDay, proceduresOf } from './agendaData.js';

const STORAGE_KEY = 'agenda.selected';

function readSelection() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    return null;
  }
}

export function AgendaPage() {
  const toast = useToast();
  const { staff } = useAuth();
  const [day, setDay] = useState(localDay());
  const [mode, setMode] = useState('grade');
  const [showCancelled, setShowCancelled] = useState(false);
  const [selected, setSelected] = useState(readSelection);
  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(null);
  const [blocking, setBlocking] = useState(false);

  const { data: agendas = [] } = useLoad(loadAgendas, []);
  const { data: dayData, reload } = useLoad(() => loadDay(day), [day]);

  // Default selection: the professional's own agenda, otherwise all.
  useEffect(() => {
    if (selected || agendas.length === 0) return;
    setSelected(staff?.role === 'profissional' && staff.agenda_id ? [staff.agenda_id] : agendas.map((a) => a.id));
  }, [agendas, selected, staff]);

  useEffect(() => {
    try {
      if (selected) localStorage.setItem(STORAGE_KEY, JSON.stringify(selected));
    } catch {
      // private mode: selection just isn't remembered
    }
  }, [selected]);

  useEffect(() => {
    const channel = supabase
      .channel('agenda-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'appointments' }, () => reload())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [reload]);
  useInterval(reload, 30000);

  const visibleAgendas = agendas.filter((a) => (selected ?? []).includes(a.id));
  const appointments = useMemo(
    () => (dayData?.appointments ?? []).filter((a) => showCancelled || a.status !== 'cancelado'),
    [dayData, showCancelled],
  );
  const openAppointment = dayData?.appointments.find((a) => a.id === openId) ?? null;

  function toggleAgenda(id) {
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : agendas.map((a) => a.id).filter((x) => x === id || cur.includes(x))));
  }

  async function moveAppointment(appt, { agendaId, startMin, endMin }) {
    const before = { agenda_id: appt.agenda_id, starts_at: appt.starts_at, ends_at: appt.ends_at, appointment_type_id: appt.appointment_type_id, status: appt.status };
    const changes = {
      agenda_id: agendaId,
      starts_at: zonedToUtc(day, minutesToTime(startMin)).toISOString(),
      ends_at: zonedToUtc(day, minutesToTime(endMin)).toISOString(),
    };
    if (agendaId !== appt.agenda_id) changes.appointment_type_id = defaultType(agendas.find((a) => a.id === agendaId))?.id ?? null;
    if (appt.status === 'pediu_remarcar') changes.status = 'agendado';
    const { error } = await supabase.from('appointments').update(changes).eq('id', appt.id);
    if (error) return toast.error(error);
    reload();
    toast.info(`${appt.patient?.full_name}: ${minutesToTime(startMin)}–${minutesToTime(endMin)}`, {
      action: {
        label: 'Desfazer',
        onClick: async () => {
          await supabase.from('appointments').update(before).eq('id', appt.id);
          reload();
        },
      },
    });
  }

  async function removeBlock(block) {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Desbloquear este horário${block.reason ? ` (${block.reason})` : ''}?`)) return;
    const { error } = await supabase.from('agenda_blocks').delete().eq('id', block.id);
    if (error) return toast.error(error);
    reload();
  }

  const rel = relativeDayLabel(day);

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <h1>Agenda</h1>
          <div className="sub">Clínica Dr. Everson Rezeck</div>
        </div>
        <div className="topbar-right">
          <button type="button" className="btn" onClick={() => setBlocking(true)}><Lock /> Bloquear horário</button>
          <button type="button" className="btn btn-primary" onClick={() => setCreating({ day, time: '09:00', agendaId: visibleAgendas[0]?.id })}>
            <Plus /> Agendar
          </button>
        </div>
      </header>

      <div className="card agenda-toolbar">
        <div className="seg">
          <button type="button" className={mode === 'grade' ? 'active' : ''} onClick={() => setMode('grade')}>Grade</button>
          <button type="button" className={mode === 'lista' ? 'active' : ''} onClick={() => setMode('lista')}>Lista</button>
        </div>
        <div className="daynav">
          <button type="button" className="icon-btn" onClick={() => setDay(addDays(day, -1))} aria-label="Dia anterior"><ChevronLeft /></button>
          <label className="daylabel" title="Escolher data">
            {rel ? `${rel} · ${formatWeekday(day)}` : formatWeekday(day)}
            <span className="d2">{formatFullDate(day)}</span>
            <input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />
          </label>
          <button type="button" className="icon-btn" onClick={() => setDay(addDays(day, 1))} aria-label="Próximo dia"><ChevronRight /></button>
          {day !== localDay() && <button type="button" className="btn btn-sm" onClick={() => setDay(localDay())}>Hoje</button>}
        </div>
        <div className="row-wrap">
          {agendas.map((a) => (
            <button key={a.id} type="button" className={`chip ${(selected ?? []).includes(a.id) ? 'on' : ''}`} onClick={() => toggleAgenda(a.id)}>
              <span className="sw" style={{ background: a.color }} />{a.name}
            </button>
          ))}
        </div>
        <span className="grow" />
        <label className="check small"><input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} /> Mostrar cancelados</label>
      </div>

      <div className="card legend">
        {STATUSES.filter((s) => showCancelled || s.id !== 'cancelado').map((s) => (
          <span key={s.id} className={`legend-item st-${s.id}`}><span className="dot" />{s.legend}</span>
        ))}
      </div>

      <div className="card agenda-scroll">
        {visibleAgendas.length === 0 ? (
          <div className="empty">Selecione ao menos uma agenda.</div>
        ) : mode === 'grade' ? (
          <DayGrid
            day={day}
            agendas={visibleAgendas}
            appointments={appointments.filter((a) => visibleAgendas.some((v) => v.id === a.agenda_id))}
            blocks={dayData?.blocks ?? []}
            onOpen={(appt) => setOpenId(appt.id)}
            onCreate={({ agendaId, minutes }) => setCreating({ day, agendaId, time: minutesToTime(minutes) })}
            onMove={moveAppointment}
            onBlockClick={removeBlock}
          />
        ) : (
          <table className="table">
            <thead><tr><th style={{ width: 110 }}>Horário</th><th>Paciente</th><th>Agenda</th><th>Procedimentos</th><th style={{ width: 170 }}>Status</th></tr></thead>
            <tbody>
              {appointments.filter((a) => visibleAgendas.some((v) => v.id === a.agenda_id)).map((a) => (
                <tr key={a.id} className="click" onClick={() => setOpenId(a.id)}>
                  <td className="mono">{localTime(a.starts_at)}–{localTime(a.ends_at)}</td>
                  <td style={{ fontWeight: 700 }}>{a.patient?.full_name}</td>
                  <td>{agendas.find((g) => g.id === a.agenda_id)?.name}</td>
                  <td className="small">{proceduresOf(a).map((p) => p.name).join(', ')}</td>
                  <td><StatusPill status={a.status} /></td>
                </tr>
              ))}
              {appointments.length === 0 && <tr><td colSpan={5} className="empty">Nenhum agendamento neste dia.</td></tr>}
            </tbody>
          </table>
        )}
      </div>

      {openAppointment && (
        <AppointmentDrawer appointment={openAppointment} agendas={agendas} onClose={() => setOpenId(null)} onChanged={reload} />
      )}
      {creating && (
        <AppointmentModal
          agendas={agendas}
          prefill={creating}
          onClose={() => setCreating(null)}
          onSaved={() => { setCreating(null); reload(); }}
        />
      )}
      {blocking && <BlockModal agendas={agendas} day={day} onClose={() => setBlocking(false)} onSaved={() => { setBlocking(false); reload(); }} />}
    </div>
  );
}
