import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, List, Lock, Plus } from 'lucide-react';
import { supabase } from '../../lib/supabase.js';
import { useLoad, useInterval } from '../../lib/hooks.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { STATUSES } from '../../lib/status.js';
import { StatusPill, Empty } from '../../components/ui.jsx';
import {
  addDays, formatDay, formatFullDate, formatWeekday, localDay, localTime, minutesToTime, relativeDayLabel, weekday, zonedToUtc,
} from '../../lib/time.js';
import { TimeGrid } from './TimeGrid.jsx';
import { MonthGrid, monthDays } from './MonthGrid.jsx';
import { AppointmentSheet } from './AppointmentSheet.jsx';
import { AppointmentModal } from './AppointmentModal.jsx';
import { BlockModal } from './BlockModal.jsx';
import { defaultType, loadAgendas, loadRange, openWindows, proceduresOf } from './agendaData.js';

const VIEWS = [['dia', 'Dia'], ['semana', 'Semana'], ['mes', 'Mês']];
const WEEKDAY_SHORT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const monthName = new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', month: 'long', year: 'numeric' });
const dayMonth = new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', day: 'numeric', month: 'short' });

function remembered(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback;
  } catch {
    return fallback;
  }
}
function remember(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private mode: just not remembered
  }
}

const mondayOf = (day) => addDays(day, -((weekday(day) + 6) % 7));
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const fmtDayMonth = (day) => dayMonth.format(new Date(`${day}T12:00:00Z`)).replace('.', '');

function rangeFor(view, day) {
  if (view === 'semana') {
    const start = mondayOf(day);
    return [start, addDays(start, 7)];
  }
  if (view === 'mes') {
    const days = monthDays(day.slice(0, 7));
    return [days[0], addDays(days[days.length - 1], 1)];
  }
  return [day, addDays(day, 1)];
}

function step(view, day, direction) {
  if (view === 'semana') return addDays(day, 7 * direction);
  if (view === 'mes') {
    const [y, m] = day.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + direction, 1));
    return d.toISOString().slice(0, 10);
  }
  return addDays(day, direction);
}

export function AgendaPage() {
  const toast = useToast();
  const { staff } = useAuth();
  const [day, setDay] = useState(localDay());
  const [view, setViewState] = useState(() => remembered('agenda.view', 'dia'));
  const [asList, setAsList] = useState(false);
  const [showCancelled, setShowCancelled] = useState(false);
  const [selected, setSelected] = useState(() => remembered('agenda.selected', null));
  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(null);
  const [blocking, setBlocking] = useState(false);

  const setView = (v) => { setViewState(v); remember('agenda.view', v); };
  const [from, to] = rangeFor(view, day);

  const { data: agendas = [] } = useLoad(loadAgendas, []);
  const { data: range, reload } = useLoad(() => loadRange(from, to), [from, to]);

  // Default selection: the professional's own agenda, otherwise all.
  useEffect(() => {
    if (selected || agendas.length === 0) return;
    setSelected(staff?.role === 'profissional' && staff.agenda_id ? [staff.agenda_id] : agendas.map((a) => a.id));
  }, [agendas, selected, staff]);
  useEffect(() => { if (selected) remember('agenda.selected', selected); }, [selected]);

  useEffect(() => {
    const channel = supabase
      .channel('agenda-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'appointments' }, () => reload())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [reload]);
  useInterval(reload, 30000);

  const visibleAgendas = agendas.filter((a) => (selected ?? []).includes(a.id));
  const visibleIds = new Set(visibleAgendas.map((a) => a.id));
  const appointments = useMemo(
    () => (range?.appointments ?? []).filter((a) => (showCancelled || a.status !== 'cancelado') && (selected ?? []).includes(a.agenda_id)),
    [range, showCancelled, selected],
  );
  const openAppointment = range?.appointments.find((a) => a.id === openId) ?? null;
  const agendaColor = (id) => agendas.find((a) => a.id === id)?.color ?? '#999';
  const activeCount = appointments.filter((a) => a.status !== 'cancelado').length;

  function toggleAgenda(id) {
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : agendas.map((a) => a.id).filter((x) => x === id || cur.includes(x))));
  }

  async function moveAppointment(appt, { day: targetDay, agendaId, startMin, endMin }) {
    const before = { agenda_id: appt.agenda_id, starts_at: appt.starts_at, ends_at: appt.ends_at, appointment_type_id: appt.appointment_type_id, status: appt.status };
    const changes = {
      agenda_id: agendaId,
      starts_at: zonedToUtc(targetDay, minutesToTime(startMin)).toISOString(),
      ends_at: zonedToUtc(targetDay, minutesToTime(endMin)).toISOString(),
    };
    if (agendaId !== appt.agenda_id) changes.appointment_type_id = defaultType(agendas.find((a) => a.id === agendaId))?.id ?? null;
    if (appt.status === 'pediu_remarcar') changes.status = 'agendado';
    const { error } = await supabase.from('appointments').update(changes).eq('id', appt.id);
    if (error) return toast.error(error);
    reload();
    const when = targetDay === localDay(appt.starts_at) ? '' : `${formatDay(targetDay)} `;
    toast.info(`${appt.patient?.full_name}: ${when}${minutesToTime(startMin)}–${minutesToTime(endMin)}`, {
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

  const openDay = (d) => { setDay(d); setView('dia'); };
  const goToday = () => setDay(localDay());
  const isCurrent = view === 'dia' ? day === localDay() : view === 'semana' ? mondayOf(day) === mondayOf(localDay()) : day.slice(0, 7) === localDay().slice(0, 7);

  let title;
  let subtitle;
  if (view === 'dia') {
    const rel = relativeDayLabel(day);
    title = rel ? `${rel} · ${formatWeekday(day)}` : formatWeekday(day);
    subtitle = formatFullDate(day);
  } else if (view === 'semana') {
    const end = addDays(from, 6);
    title = `${fmtDayMonth(from)} – ${fmtDayMonth(end)}`;
    subtitle = `Semana de ${from.slice(0, 4)}`;
  } else {
    title = capitalize(monthName.format(new Date(`${day.slice(0, 7)}-15T12:00:00Z`)));
    subtitle = `${activeCount} atendimentos no mês`;
  }

  // Week: Monday to Friday, plus the weekend when something happens on it.
  const weekDays = useMemo(() => {
    if (view !== 'semana') return [];
    return Array.from({ length: 7 }, (_, i) => addDays(from, i)).filter((d) => {
      const dow = weekday(d);
      if (dow >= 1 && dow <= 5) return true;
      return visibleAgendas.some((a) => openWindows(a, d).length) || appointments.some((a) => localDay(a.starts_at) === d);
    });
  }, [view, from, visibleAgendas, appointments]);

  const columns = view === 'semana'
    ? weekDays.map((d) => {
      const count = appointments.filter((a) => localDay(a.starts_at) === d && a.status !== 'cancelado').length;
      return {
        key: d,
        day: d,
        agendas: visibleAgendas,
        header: (
          <>
            <div className="dname">{WEEKDAY_SHORT[weekday(d)]}</div>
            <div className="dnum">{Number(d.slice(8))}</div>
            <div className="prole">{count ? `${count} ${count === 1 ? 'atendimento' : 'atendimentos'}` : '—'}</div>
          </>
        ),
      };
    })
    : visibleAgendas.map((agenda) => {
      const count = appointments.filter((a) => a.agenda_id === agenda.id && a.status !== 'cancelado').length;
      return {
        key: agenda.id,
        day,
        agendas: [agenda],
        header: (
          <>
            <div className="pname"><i style={{ background: agenda.color }} />{agenda.name}</div>
            <div className="prole">{count} {count === 1 ? 'atendimento' : 'atendimentos'}</div>
          </>
        ),
      };
    });

  const listRows = appointments.filter((a) => visibleIds.has(a.agenda_id));

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <h1>Agenda</h1>
          <div className="sub">{view === 'mes' ? subtitle : `${activeCount} ${activeCount === 1 ? 'atendimento' : 'atendimentos'} ${view === 'semana' ? 'na semana' : 'no dia'}`}</div>
        </div>
        <div className="topbar-right">
          <button type="button" className="btn" onClick={() => setBlocking(true)}><Lock /> Bloquear horário</button>
          <button type="button" className="btn btn-primary" onClick={() => setCreating({ day: view === 'dia' ? day : localDay() >= from && localDay() < to ? localDay() : from, time: '09:00', agendaId: visibleAgendas[0]?.id })}>
            <Plus /> Agendar
          </button>
        </div>
      </header>

      <div className="card agenda-toolbar">
        <div className="seg" role="tablist" aria-label="Visualização">
          {VIEWS.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={view === id} className={view === id ? 'active' : ''} onClick={() => setView(id)}>{label}</button>
          ))}
        </div>
        <div className="daynav">
          <button type="button" className="icon-btn ghost" onClick={() => setDay(step(view, day, -1))} aria-label="Anterior"><ChevronLeft /></button>
          <button type="button" className="icon-btn ghost" onClick={() => setDay(step(view, day, 1))} aria-label="Próximo"><ChevronRight /></button>
          <label className="daylabel" title="Escolher data">
            {title}
            <span className="d2">{view === 'mes' ? 'Clique em um dia para abrir' : subtitle}</span>
            {view === 'mes'
              ? <input type="month" value={day.slice(0, 7)} onChange={(e) => e.target.value && setDay(`${e.target.value}-01`)} />
              : <input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />}
          </label>
          <button type="button" className="btn btn-sm" onClick={goToday} disabled={isCurrent}>Hoje</button>
        </div>
        <span className="grow" />
        <div className="agenda-chips">
          {agendas.map((a) => (
            <button key={a.id} type="button" className={`chip ${(selected ?? []).includes(a.id) ? 'on' : ''}`} onClick={() => toggleAgenda(a.id)} aria-pressed={(selected ?? []).includes(a.id)}>
              <span className="sw" style={{ background: a.color }} />{a.name}
            </button>
          ))}
        </div>
        {view !== 'mes' && (
          <div className="seg" aria-label="Formato">
            <button type="button" className={!asList ? 'active' : ''} onClick={() => setAsList(false)} title="Grade" aria-label="Grade"><CalendarDays /></button>
            <button type="button" className={asList ? 'active' : ''} onClick={() => setAsList(true)} title="Lista" aria-label="Lista"><List /></button>
          </div>
        )}
      </div>

      <div className="legend">
        {STATUSES.filter((s) => showCancelled || s.id !== 'cancelado').map((s) => (
          <span key={s.id} className={`legend-item st-${s.id}`}><span className="dot" />{s.legend}</span>
        ))}
        <span className="grow" />
        {view === 'semana' && !asList && visibleAgendas.length > 2 && <span className="week-hint">Dica: marque uma só agenda para ver mais detalhes</span>}
        <label className="check small"><input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} /> Mostrar cancelados</label>
      </div>

      <div className="card agenda-scroll" key={`${view}-${asList}`}>
        {visibleAgendas.length === 0 ? (
          <Empty icon={CalendarDays}>Selecione ao menos uma agenda.</Empty>
        ) : view === 'mes' ? (
          <MonthGrid month={day.slice(0, 7)} appointments={listRows} agendaColor={agendaColor} onPickDay={openDay} />
        ) : asList ? (
          <table className="table">
            <thead>
              <tr>
                {view === 'semana' && <th style={{ width: 130 }}>Dia</th>}
                <th style={{ width: 120 }}>Horário</th><th>Paciente</th><th>Agenda</th><th>Procedimentos</th><th style={{ width: 180 }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {listRows.map((a) => (
                <tr key={a.id} className="click" onClick={() => setOpenId(a.id)}>
                  {view === 'semana' && <td>{WEEKDAY_SHORT[weekday(localDay(a.starts_at))]} {formatDay(localDay(a.starts_at)).slice(0, 5)}</td>}
                  <td className="tnum">{localTime(a.starts_at)}–{localTime(a.ends_at)}</td>
                  <td style={{ fontWeight: 600 }}>{a.patient?.full_name}</td>
                  <td><span className="row" style={{ gap: 7 }}><i style={{ width: 8, height: 8, borderRadius: 99, background: agendaColor(a.agenda_id), display: 'inline-block' }} />{agendas.find((g) => g.id === a.agenda_id)?.name}</span></td>
                  <td className="small muted">{proceduresOf(a).map((p) => p.name).join(', ')}</td>
                  <td><StatusPill status={a.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <TimeGrid
            columns={columns}
            appointments={listRows}
            blocks={range?.blocks ?? []}
            agendaColor={agendaColor}
            scrollKey={`${view}|${from}|${visibleAgendas.length}`}
            onOpen={(appt) => setOpenId(appt.id)}
            onCreate={({ day: d, agendaId, minutes }) => setCreating({ day: d, agendaId: agendaId ?? visibleAgendas[0]?.id, time: minutesToTime(minutes) })}
            onMove={moveAppointment}
            onBlockClick={removeBlock}
            onHeaderClick={view === 'semana' ? (column) => openDay(column.day) : undefined}
          />
        )}
        {asList && view !== 'mes' && listRows.length === 0 && <Empty icon={CalendarDays}>Nenhum agendamento neste período.</Empty>}
      </div>

      {openAppointment && (
        <AppointmentSheet appointment={openAppointment} agendas={agendas} onClose={() => setOpenId(null)} onChanged={reload} />
      )}
      {creating && (
        <AppointmentModal
          agendas={agendas}
          prefill={creating}
          onClose={() => setCreating(null)}
          onSaved={() => { setCreating(null); reload(); }}
        />
      )}
      {blocking && <BlockModal agendas={agendas} day={view === 'dia' ? day : from} onClose={() => setBlocking(false)} onSaved={() => { setBlocking(false); reload(); }} />}
    </div>
  );
}
