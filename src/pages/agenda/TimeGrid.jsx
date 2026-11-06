import { useEffect, useMemo, useRef, useState } from 'react';
import { displayStatus } from '../../lib/status.js';
import { localDay, localMinutes, minutesToTime } from '../../lib/time.js';
import { useInterval } from '../../lib/hooks.js';
import { fixedTimes, openWindows, proceduresOf } from './agendaData.js';

const PX = 2; // pixels per minute: a 20-minute visit fits time, name and procedure
const SNAP = 5; // minutes
const TIME_COL = 60;
const HOLD_MS = 400; // on a touch screen, hold a booking this long to move it
const GAP_PX = 14; // the thin band that stands for hours nobody works

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
  const [held, setHeld] = useState(null);

  // While a booking is held on a touch screen, the page must not scroll.
  useEffect(() => {
    const stop = (e) => { if (dragRef.current?.armed && e.cancelable) e.preventDefault(); };
    document.addEventListener('touchmove', stop, { passive: false });
    return () => document.removeEventListener('touchmove', stop);
  }, []);
  const [now, setNow] = useState(() => localMinutes(new Date()));
  useInterval(() => setNow(localMinutes(new Date())), 60000);
  const today = localDay();

  const columnIndexOf = (appt) => {
    const day = localDay(appt.starts_at);
    return columns.findIndex((c) => c.day === day && c.agendas.some((a) => a.id === appt.agenda_id));
  };

  // Only the hours someone works are drawn: the opening windows of the agendas
  // shown, plus any booking outside them. Hours nobody works (the lunch break,
  // mornings an agenda does not open) collapse into a thin band.
  const segments = useMemo(() => {
    const spans = [];
    for (const column of columns) spans.push(...unionWindows(column.agendas, column.day));
    for (const appt of appointments) spans.push(minutesOf(appt));
    if (spans.length === 0) spans.push([8 * 60, 19 * 60]);
    const merged = [];
    for (const [s0, e0] of spans.map(([s, e]) => [Math.max(0, Math.floor(s / 30) * 30), Math.min(24 * 60, Math.ceil(e / 30) * 30)]).sort((a, b) => a[0] - b[0])) {
      const last = merged[merged.length - 1];
      if (last && s0 <= last[1]) last[1] = Math.max(last[1], e0);
      else merged.push([s0, e0]);
    }
    let top = 0;
    return merged.map(([s, e], i) => {
      const seg = { s, e, top: top + (i ? GAP_PX : 0) };
      top = seg.top + (e - s) * PX;
      return seg;
    });
  }, [columns, appointments]);
  const rangeStart = segments[0].s;
  const rangeEnd = segments[segments.length - 1].e;
  const last = segments[segments.length - 1];
  const height = last.top + (last.e - last.s) * PX;
  // minute → pixel (a minute in a hidden gap sits on the edge of the band)
  const y = (minute) => {
    let prev = segments[0];
    for (const seg of segments) {
      if (minute < seg.s) return prev === seg ? seg.top : prev.top + (prev.e - prev.s) * PX;
      if (minute <= seg.e) return seg.top + (minute - seg.s) * PX;
      prev = seg;
    }
    return height;
  };
  // pixel → minute, on the visible hours only
  const minuteAt = (px) => {
    for (const seg of segments) {
      const bottom = seg.top + (seg.e - seg.s) * PX;
      if (px < seg.top) return seg.s;
      if (px <= bottom) return seg.s + (px - seg.top) / PX;
    }
    return rangeEnd;
  };
  const visible = (minute) => segments.some((seg) => minute >= seg.s && minute <= seg.e);
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
    scroller.scrollTop = Math.max(0, y(Math.max(rangeStart, target)));
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
    const minute = minuteAt(event.clientY - rect.top);
    const fixed = column.agendas.length === 1 ? fixedTimes(column.agendas[0], column.day) : [];
    const slot = [...fixed].reverse().find((t) => t <= minute && minute - t < 60);
    onCreate({ day: column.day, agendaId: column.agendas.length === 1 ? column.agendas[0].id : null, minutes: slot ?? Math.floor(minute / SNAP) * SNAP });
  }

  // Mouse: drag right away. Touch: a quick touch opens the booking and a
  // swipe scrolls the agenda; only holding it still for a moment picks it up.
  function pointerDown(event, item, mode) {
    if (event.button !== 0) return;
    event.stopPropagation();
    const target = event.currentTarget;
    const d = { item, mode, x: event.clientX, y: event.clientY, moved: false, armed: event.pointerType !== 'touch' };
    dragRef.current = d;
    if (d.armed) {
      target.setPointerCapture(event.pointerId);
      return;
    }
    const { pointerId } = event;
    d.timer = setTimeout(() => {
      if (dragRef.current !== d) return;
      d.armed = true;
      try { target.setPointerCapture(pointerId); } catch { /* the finger already left */ }
      setHeld(item.id);
      navigator.vibrate?.(15);
    }, HOLD_MS);
  }

  function pointerCancel() {
    const d = dragRef.current;
    if (d?.timer) clearTimeout(d.timer);
    dragRef.current = null;
    setHeld(null);
    setDrag(null);
  }

  function pointerMove(event) {
    const d = dragRef.current;
    if (!d) return;
    const dx = event.clientX - d.x;
    const dy = event.clientY - d.y;
    if (!d.armed) {
      // the finger moved before the hold: it is a scroll, not a drag
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) pointerCancel();
      return;
    }
    if (!d.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    d.moved = true;
    const snap = (m) => Math.round(m / SNAP) * SNAP;
    const { item } = d;
    if (d.mode === 'move') {
      const duration = item.end - item.start;
      const start = Math.min(Math.max(snap(minuteAt(y(item.start) + dy)), rangeStart), rangeEnd - duration);
      const colWidth = (bodyRef.current.getBoundingClientRect().width - TIME_COL) / columns.length;
      let col = Math.min(Math.max(item.col + Math.round(dx / colWidth), 0), columns.length - 1);
      // In the week view a booking keeps its agenda: only columns showing it qualify.
      if (!columns[col].agendas.some((a) => a.id === item.appt.agenda_id) && columns[col].agendas.length > 1) col = item.col;
      d.last = { id: item.id, col, start, end: start + duration };
    } else {
      const end = Math.min(Math.max(snap(minuteAt(y(item.end) + dy)), item.start + SNAP), rangeEnd);
      d.last = { id: item.id, col: item.col, start: item.start, end };
    }
    setDrag(d.last);
  }

  function pointerUp() {
    const d = dragRef.current;
    dragRef.current = null;
    setHeld(null);
    if (!d) return;
    if (d.timer) clearTimeout(d.timer);
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

  // One agenda on one day: the lines and labels follow its own start times
  // (FastClinic's 12:15, 16:10...). Otherwise every 30 minutes.
  const exact = columns.length === 1 && columns[0].agendas.length === 1 ? fixedTimes(columns[0].agendas[0], columns[0].day) : [];
  const marks = [];
  if (exact.length) marks.push(...exact.filter(visible));
  else for (const seg of segments) for (let m = seg.s; m <= seg.e; m += 30) marks.push(m);
  // each visible stretch is labelled from its first hour
  // (an hour sitting right on top of a hidden band is not labelled: the next
  // stretch's first hour, just below the band, says where things resume)
  const starts = new Set(segments.slice(1).map((seg) => seg.s));
  const ends = new Set(segments.slice(0, -1).map((seg) => seg.e));
  const labels = [...new Set([...starts, ...marks.filter((m) => m > rangeStart)])].filter((m) => !ends.has(m) || starts.has(m)).sort((a, b) => a - b);
  const gaps = segments.slice(1).map((seg, i) => ({ top: segments[i].top + (segments[i].e - segments[i].s) * PX, from: segments[i].e, to: seg.s }));

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
          {labels.map((m) => (
            <span key={m} className={`time-label ${!exact.length && m % 60 ? 'half' : ''} ${starts.has(m) ? 'after-gap' : ''}`} style={{ top: y(m) }}>{minutesToTime(m)}</span>
          ))}
          {gaps.map((g) => <span key={g.from} className="time-gap" style={{ top: g.top, height: GAP_PX }} title={`${minutesToTime(g.from)}–${minutesToTime(g.to)}: ninguém atende`} />)}
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
                <div key={`${s}-${e}`} className="open" style={{ top: y(s), height: y(e) - y(s) }} />
              ))}
              {marks.map((m) => <div key={m} className={exact.length || m % 60 === 0 ? 'hourline' : 'halfline'} style={{ top: y(m) }} />)}
              {gaps.map((g) => <div key={`g${g.from}`} className="grid-gap" style={{ top: g.top, height: GAP_PX }} />)}
              {!exact.length && fixed.filter(visible).map((m) => <div key={`f${m}`} className="fixed-slot" style={{ top: y(m) }} title={minutesToTime(m)} />)}
              {colBlocks.map((b) => {
                const s = Math.max(localDay(b.starts_at) === column.day ? localMinutes(b.starts_at) : 0, rangeStart);
                const e = Math.min(localDay(b.ends_at) === column.day ? localMinutes(b.ends_at) : 24 * 60, rangeEnd);
                if (y(e) - y(s) <= 0) return null;
                return (
                  <div key={b.id} className="block" style={{ top: y(s), height: y(e) - y(s) }} title={b.reason ?? 'Bloqueado'}
                    onClick={(ev) => { ev.stopPropagation(); onBlockClick(b); }}>
                    {b.agenda_id === null ? 'Clínica fechada' : 'Bloqueado'}{b.reason ? ` · ${b.reason}` : ''}
                  </div>
                );
              })}
              {column.day === today && visible(now) && <div className="now-line" style={{ top: y(now) }} />}
              {items.map((item) => {
                const { appt } = item;
                const lane = lanes.get(item.id);
                const h = Math.max(y(item.end) - y(item.start), 18);
                const compact = h < 30;
                const short = !compact && h < 56; // time and name share the first line
                // several bookings side by side in a narrow column: names only
                const narrow = lane.lanes > 2 || (lane.lanes > 1 && columns.length > 4);
                const procs = proceduresOf(appt).map((p) => p.name).join(', ');
                const dot = !single && agendaColor ? agendaColor(appt.agenda_id) : null;
                return (
                  <div
                    key={appt.id}
                    className={`appt st-${appt.removed_at ? 'removido' : displayStatus(appt.status)} ${compact ? 'compact' : ''} ${short ? 'short' : ''} ${narrow ? 'narrow' : ''} ${drag?.id === appt.id ? 'dragging' : ''} ${held === appt.id ? 'held' : ''}`}
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
                    onPointerCancel={pointerCancel}
                    data-testid="appointment"
                  >
                    <div className="head">
                      <span className="t">{dot && <i style={{ background: dot }} />}{minutesToTime(item.start)}{compact || short || narrow ? '' : `–${minutesToTime(item.end)}`}</span>
                      <span className="n">{narrow ? shortName(appt.patient?.full_name) : appt.patient?.full_name}</span>
                    </div>
                    {!compact && procs && <div className="p">{procs}</div>}
                    <div className="resize" onPointerDown={(e) => pointerDown(e, item, 'resize')} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerCancel} />
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
