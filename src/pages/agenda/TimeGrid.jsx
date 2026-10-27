import { useEffect, useMemo, useRef, useState } from 'react';
import { localDay, localMinutes, minutesToTime } from '../../lib/time.js';
import { useInterval } from '../../lib/hooks.js';
import { fixedTimes, openWindows, proceduresOf } from './agendaData.js';

const PX = 1.5; // pixels per minute
const SNAP = 5; // minutes
const TIME_COL = 60;

function minutesOf(appt) {
  const start = localMinutes(appt.starts_at);
  const duration = Math.max(5, Math.round((new Date(appt.ends_at) - new Date(appt.starts_at)) / 60000));
  return [start, start + duration];
}

// Side-by-side lanes for overlapping bookings (encaixes, the aesthetics beds,
// or several agendas in the week view).
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

const shortName = (name) => {
  const parts = String(name ?? '').trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0] ?? '';
};

// Opening hours of several agendas on a day, merged into non-overlapping windows.
function unionWindows(agendas, day) {
  const merged = [];
  for (const [s, e] of agendas.flatMap((a) => openWindows(a, day)).sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

// Time grid shared by the day view (one column per agenda) and the week view
// (one column per day). A column is { key, day, agendas, header }: the
// bookings of those agendas on that day go in it. Dragging moves a booking
// to another column (agenda or day) and time; dragging the bottom edge
// changes its length.
export function TimeGrid({ columns, appointments, blocks, agendaColor, onOpen, onCreate, onMove, onBlockClick, onHeaderClick, scrollKey }) {
  const bodyRef = useRef(null);
  const dragRef = useRef(null);
  const [drag, setDrag] = useState(null);
  const [now, setNow] = useState(() => localMinutes(new Date()));
  useInterval(() => setNow(localMinutes(new Date())), 60000);
  const today = localDay();

  const columnIndexOf = (appt) => {
    const day = localDay(appt.starts_at);
    return columns.findIndex((c) => c.day === day && c.agendas.some((a) => a.id === appt.agenda_id));
  };

  const [rangeStart, rangeEnd] = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const column of columns) {
      for (const [s, e] of unionWindows(column.agendas, column.day)) {
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
  }, [columns, appointments]);

  const height = (rangeEnd - rangeStart) * PX;
  const y = (minute) => (minute - rangeStart) * PX;
  const minWidth = columns.length > 5 ? 128 : 180;
  const template = `${TIME_COL}px repeat(${columns.length}, minmax(${minWidth}px, 1fr))`;
  const showsToday = columns.some((c) => c.day === today);

  // Scroll to now (today) or to the first booking when the view changes.
  const scrolledFor = useRef(null);
  useEffect(() => {
    const scroller = bodyRef.current?.closest('.agenda-scroll');
    if (!scroller || scrolledFor.current === scrollKey) return;
    const firstStart = Math.min(...appointments.map((a) => minutesOf(a)[0]));
    const target = showsToday ? now - 60 : Number.isFinite(firstStart) ? firstStart - 30 : rangeStart;
    scroller.scrollTop = Math.max(0, (target - rangeStart) * PX);
    if (appointments.length || showsToday) scrolledFor.current = scrollKey;
  }, [scrollKey, appointments]); // eslint-disable-line react-hooks/exhaustive-deps

  const placed = appointments.map((appt) => {
    const [start, end] = minutesOf(appt);
    if (drag?.id === appt.id) return { appt, id: appt.id, col: drag.col, start: drag.start, end: drag.end };
    return { appt, id: appt.id, col: columnIndexOf(appt), start, end };
  }).filter((p) => p.col >= 0);

  function columnClick(event, column) {
    if (event.target.closest('.appt, .block')) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const minute = rangeStart + (event.clientY - rect.top) / PX;
    const fixed = column.agendas.length === 1 ? fixedTimes(column.agendas[0], column.day) : [];
    const slot = [...fixed].reverse().find((t) => t <= minute && minute - t < 60);
    onCreate({ day: column.day, agendaId: column.agendas.length === 1 ? column.agendas[0].id : null, minutes: slot ?? Math.floor(minute / SNAP) * SNAP });
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
      const colWidth = (bodyRef.current.getBoundingClientRect().width - TIME_COL) / columns.length;
      let col = Math.min(Math.max(item.col + Math.round(dx / colWidth), 0), columns.length - 1);
      // In the week view a booking keeps its agenda: only columns showing it qualify.
      if (!columns[col].agendas.some((a) => a.id === item.appt.agenda_id) && columns[col].agendas.length > 1) col = item.col;
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
      const target = columns[final.col];
      const agendaId = target.agendas.length === 1 ? target.agendas[0].id : d.item.appt.agenda_id;
      onMove(d.item.appt, { day: target.day, agendaId, startMin: final.start, endMin: final.end });
    }
  }

  const marks = [];
  for (let m = rangeStart; m <= rangeEnd; m += 30) marks.push(m);

  return (
    <div className="grid" style={{ gridTemplateColumns: template }}>
      <div className="grid-head" style={{ gridColumn: '1 / -1', gridTemplateColumns: template }}>
        <div className="grid-head-cell" />
        {columns.map((column) => (
          <div
            key={column.key}
            className={`grid-head-cell ${onHeaderClick ? 'day-head' : ''} ${column.day === today && onHeaderClick ? 'today' : ''}`}
            onClick={onHeaderClick ? () => onHeaderClick(column) : undefined}
          >
            {column.header}
          </div>
        ))}
      </div>
      <div ref={bodyRef} className="grid-body" style={{ gridColumn: '1 / -1', gridTemplateColumns: template, height }}>
        <div className="time-col">
          {marks.filter((m) => m % 60 === 0 && m > rangeStart).map((m) => (
            <span key={m} className="time-label" style={{ top: y(m) }}>{minutesToTime(m)}</span>
          ))}
        </div>
        {columns.map((column, col) => {
          const single = column.agendas.length === 1 ? column.agendas[0] : null;
          const fixed = single ? fixedTimes(single, column.day) : [];
          const items = placed.filter((p) => p.col === col);
          const lanes = layoutLanes(items);
          const ids = new Set(column.agendas.map((a) => a.id));
          const colBlocks = blocks.filter((b) => (b.agenda_id === null || ids.has(b.agenda_id))
            && localDay(b.starts_at) <= column.day && localDay(b.ends_at) >= column.day);
          return (
            <div key={column.key} className={`agenda-col ${column.day === today ? 'today' : ''}`} style={{ height }} onClick={(e) => columnClick(e, column)} data-agenda={single?.name ?? column.day} data-day={column.day}>
              {unionWindows(column.agendas, column.day).map(([s, e]) => (
                <div key={`${s}-${e}`} className="open" style={{ top: y(s), height: (e - s) * PX }} />
              ))}
              {marks.map((m) => <div key={m} className={m % 60 === 0 ? 'hourline' : 'halfline'} style={{ top: y(m) }} />)}
              {fixed.map((m) => <div key={`f${m}`} className="fixed-slot" style={{ top: y(m) }} title={minutesToTime(m)} />)}
              {colBlocks.map((b) => {
                const s = Math.max(localDay(b.starts_at) === column.day ? localMinutes(b.starts_at) : 0, rangeStart);
                const e = Math.min(localDay(b.ends_at) === column.day ? localMinutes(b.ends_at) : 24 * 60, rangeEnd);
                if (e <= s) return null;
                return (
                  <div key={b.id} className="block" style={{ top: y(s), height: (e - s) * PX }} title={b.reason ?? 'Bloqueado'}
                    onClick={(ev) => { ev.stopPropagation(); onBlockClick(b); }}>
                    {b.agenda_id === null ? 'Clínica fechada' : 'Bloqueado'}{b.reason ? ` · ${b.reason}` : ''}
                  </div>
                );
              })}
              {column.day === today && now >= rangeStart && now <= rangeEnd && <div className="now-line" style={{ top: y(now) }} />}
              {items.map((item) => {
                const { appt } = item;
                const lane = lanes.get(item.id);
                const h = Math.max((item.end - item.start) * PX, 18);
                const compact = h < 36;
                // several bookings side by side in a narrow column: names only
                const narrow = lane.lanes > 2 || (lane.lanes > 1 && columns.length > 4);
                const procs = proceduresOf(appt).map((p) => p.name).join(', ');
                const dot = !single && agendaColor ? agendaColor(appt.agenda_id) : null;
                return (
                  <div
                    key={appt.id}
                    className={`appt st-${appt.status} ${compact ? 'compact' : ''} ${narrow ? 'narrow' : ''} ${drag?.id === appt.id ? 'dragging' : ''}`}
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
                    <div className="t">{dot && <i style={{ background: dot }} />}{minutesToTime(item.start)}{compact || narrow ? '' : `–${minutesToTime(item.end)}`}</div>
                    <div className="n">{narrow ? shortName(appt.patient?.full_name) : appt.patient?.full_name}</div>
                    {!compact && !narrow && h > 52 && procs && <div className="p">{procs}</div>}
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
