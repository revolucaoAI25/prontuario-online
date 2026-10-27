import { useEffect, useMemo, useRef, useState } from 'react';
import { localDay, localMinutes, minutesToTime } from '../../lib/time.js';
import { useInterval } from '../../lib/hooks.js';
import { fixedTimes, openWindows, proceduresOf } from './agendaData.js';

const PX = 1.5; // pixels per minute
const SNAP = 5; // minutes
const TIME_COL = 56;

function minutesOf(appt) {
  const start = localMinutes(appt.starts_at);
  const duration = Math.max(5, Math.round((new Date(appt.ends_at) - new Date(appt.starts_at)) / 60000));
  return [start, start + duration];
}

// Side-by-side lanes for overlapping bookings (encaixes, the 4 aesthetics beds).
function layoutLanes(items) {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
  const result = new Map();
  let cluster = [];
  let clusterEnd = -1;
  const flush = () => {
    const lanes = [];
    for (const item of cluster) {
      let lane = lanes.findIndex((end) => end <= item.start);
      if (lane === -1) lane = lanes.push(0) - 1;
      lanes[lane] = item.end;
      result.set(item.id, { lane });
    }
    for (const item of cluster) result.get(item.id).lanes = lanes.length;
    cluster = [];
  };
  for (const item of sorted) {
    if (cluster.length && item.start >= clusterEnd) flush();
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, item.end);
  }
  flush();
  return result;
}

export function DayGrid({ day, agendas, appointments, blocks, onOpen, onCreate, onMove, onBlockClick }) {
  const bodyRef = useRef(null);
  const dragRef = useRef(null);
  const [drag, setDrag] = useState(null);
  const [now, setNow] = useState(() => localMinutes(new Date()));
  useInterval(() => setNow(localMinutes(new Date())), 60000);
  const isToday = day === localDay();

  const [rangeStart, rangeEnd] = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const agenda of agendas) {
      for (const [s, e] of openWindows(agenda, day)) {
        lo = Math.min(lo, s);
        hi = Math.max(hi, e);
      }
    }
    for (const appt of appointments) {
      const [s, e] = minutesOf(appt);
      lo = Math.min(lo, s);
      hi = Math.max(hi, e);
    }
    if (!Number.isFinite(lo)) [lo, hi] = [8 * 60, 19 * 60];
    return [Math.max(0, Math.floor(lo / 60) * 60), Math.min(24 * 60, Math.ceil(hi / 60) * 60)];
  }, [agendas, appointments, day]);

  const height = (rangeEnd - rangeStart) * PX;

  // When the day changes, scroll to now (today) or to the first booking.
  const scrolledFor = useRef(null);
  useEffect(() => {
    const key = `${day}|${agendas.length}`;
    const scroller = bodyRef.current?.closest('.agenda-scroll');
    if (!scroller || scrolledFor.current === key) return;
    const firstStart = Math.min(...appointments.map((a) => minutesOf(a)[0]));
    const target = isToday ? now - 60 : Number.isFinite(firstStart) ? firstStart - 30 : rangeStart;
    scroller.scrollTop = Math.max(0, (target - rangeStart) * PX);
    if (appointments.length || isToday) scrolledFor.current = key;
  }, [day, agendas.length, appointments]); // eslint-disable-line react-hooks/exhaustive-deps
  const y = (minute) => (minute - rangeStart) * PX;
  const columns = `${TIME_COL}px repeat(${agendas.length}, minmax(170px, 1fr))`;

  // Effective position of each appointment, including the one being dragged.
  const placed = appointments.map((appt) => {
    const [start, end] = minutesOf(appt);
    const col = agendas.findIndex((a) => a.id === appt.agenda_id);
    if (drag?.id === appt.id) return { appt, id: appt.id, col: drag.col, start: drag.start, end: drag.end };
    return { appt, id: appt.id, col, start, end };
  }).filter((p) => p.col >= 0);

  function columnClick(event, agenda) {
    if (event.target.closest('.appt, .block')) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const minute = rangeStart + (event.clientY - rect.top) / PX;
    const fixed = fixedTimes(agenda, day);
    const slot = [...fixed].reverse().find((t) => t <= minute && minute - t < 60);
    onCreate({ agendaId: agenda.id, minutes: slot ?? Math.floor(minute / SNAP) * SNAP });
  }

  function pointerDown(event, item, mode) {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { item, mode, x: event.clientX, y: event.clientY, moved: false };
  }

  function pointerMove(event) {
    const d = dragRef.current;
    if (!d) return;
    const dx = event.clientX - d.x;
    const dy = event.clientY - d.y;
    if (!d.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    d.moved = true;
    const delta = Math.round(dy / PX / SNAP) * SNAP;
    const { item } = d;
    if (d.mode === 'move') {
      const duration = item.end - item.start;
      const start = Math.min(Math.max(item.start + delta, rangeStart), rangeEnd - duration);
      const colWidth = (bodyRef.current.getBoundingClientRect().width - TIME_COL) / agendas.length;
      const col = Math.min(Math.max(item.col + Math.round(dx / colWidth), 0), agendas.length - 1);
      d.last = { id: item.id, col, start, end: start + duration };
    } else {
      const end = Math.min(Math.max(item.end + delta, item.start + SNAP), rangeEnd);
      d.last = { id: item.id, col: item.col, start: item.start, end };
    }
    setDrag(d.last);
  }

  function pointerUp() {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (!d.moved) {
      onOpen(d.item.appt);
      return;
    }
    const final = d.last;
    setDrag(null);
    if (final && (final.col !== d.item.col || final.start !== d.item.start || final.end !== d.item.end)) {
      onMove(d.item.appt, { agendaId: agendas[final.col].id, startMin: final.start, endMin: final.end });
    }
  }

  const hourMarks = [];
  for (let m = rangeStart; m <= rangeEnd; m += 30) hourMarks.push(m);

  return (
    <div className="grid" style={{ gridTemplateColumns: columns }}>
      <div className="grid-head" style={{ gridColumn: '1 / -1', gridTemplateColumns: columns }}>
        <div className="grid-head-cell" />
        {agendas.map((agenda) => {
          const count = appointments.filter((a) => a.agenda_id === agenda.id && a.status !== 'cancelado').length;
          return (
            <div key={agenda.id} className="grid-head-cell">
              <div className="pname"><i style={{ background: agenda.color }} />{agenda.name}</div>
              <div className="prole">{count} {count === 1 ? 'atendimento' : 'atendimentos'}</div>
            </div>
          );
        })}
      </div>
      <div ref={bodyRef} className="grid-body" style={{ gridColumn: '1 / -1', gridTemplateColumns: columns, height }}>
        <div className="time-col">
          {hourMarks.filter((m) => m % 60 === 0 && m > rangeStart).map((m) => (
            <span key={m} className="time-label" style={{ top: y(m) }}>{minutesToTime(m)}</span>
          ))}
        </div>
        {agendas.map((agenda, col) => {
          const fixed = fixedTimes(agenda, day);
          const items = placed.filter((p) => p.col === col);
          const lanes = layoutLanes(items);
          const colBlocks = blocks.filter((b) => b.agenda_id === agenda.id || b.agenda_id === null);
          return (
            <div key={agenda.id} className="agenda-col" style={{ height }} onClick={(e) => columnClick(e, agenda)} data-agenda={agenda.name}>
              {openWindows(agenda, day).map(([s, e]) => (
                <div key={s} className="open" style={{ top: y(s), height: (e - s) * PX }} />
              ))}
              {hourMarks.map((m) => <div key={m} className={m % 60 === 0 ? 'hourline' : 'halfline'} style={{ top: y(m) }} />)}
              {fixed.map((m) => <div key={`f${m}`} className="fixed-slot" style={{ top: y(m) }} title={minutesToTime(m)} />)}
              {colBlocks.map((b) => {
                const startsToday = localDay(b.starts_at) === day;
                const endsToday = localDay(b.ends_at) === day;
                const s = Math.max(startsToday ? localMinutes(b.starts_at) : 0, rangeStart);
                const e = Math.min(endsToday ? localMinutes(b.ends_at) : 24 * 60, rangeEnd);
                if (e <= s) return null;
                return (
                  <div key={b.id} className="block" style={{ top: y(s), height: (e - s) * PX }} title={b.reason ?? 'Bloqueado'}
                    onClick={(ev) => { ev.stopPropagation(); onBlockClick(b); }}>
                    {b.agenda_id === null ? 'Clínica fechada' : 'Bloqueado'}{b.reason ? ` · ${b.reason}` : ''}
                  </div>
                );
              })}
              {isToday && now >= rangeStart && now <= rangeEnd && <div className="now-line" style={{ top: y(now) }} />}
              {items.map((item) => {
                const { appt } = item;
                const lane = lanes.get(item.id);
                const h = Math.max((item.end - item.start) * PX, 18);
                const compact = h < 36;
                const procs = proceduresOf(appt).map((p) => p.name).join(', ');
                return (
                  <div
                    key={appt.id}
                    className={`appt st-${appt.status} ${compact ? 'compact' : ''} ${drag?.id === appt.id ? 'dragging' : ''}`}
                    style={{
                      top: y(item.start),
                      height: h - 2,
                      left: `calc(${(lane.lane / lane.lanes) * 100}% + 2px)`,
                      width: `calc(${100 / lane.lanes}% - 4px)`,
                    }}
                    title={`${minutesToTime(item.start)}–${minutesToTime(item.end)} · ${appt.patient?.full_name}${procs ? ` · ${procs}` : ''}`}
                    onPointerDown={(e) => pointerDown(e, item, 'move')}
                    onPointerMove={pointerMove}
                    onPointerUp={pointerUp}
                    data-testid="appointment"
                  >
                    <div className="t">{minutesToTime(item.start)}{compact ? '' : `–${minutesToTime(item.end)}`}</div>
                    <div className="n">{appt.patient?.full_name}</div>
                    {!compact && h > 52 && procs && <div className="p">{procs}</div>}
                    <div className="resize" onPointerDown={(e) => pointerDown(e, item, 'resize')} onPointerMove={pointerMove} onPointerUp={pointerUp} />
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
