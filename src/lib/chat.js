import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { formatDay, localDay, localTime } from './time.js';

const GROUP_GAP_MS = 5 * 60 * 1000;

export function dayLabel(day) {
  const today = localDay();
  if (day === today) return 'Hoje';
  const yesterday = localDay(new Date(Date.now() - 86400000));
  if (day === yesterday) return 'Ontem';
  return formatDay(day);
}

// Time in a conversation list: hour today, "Ontem", else the date.
export function listTime(date) {
  if (!date) return '';
  const day = localDay(date);
  return day === localDay() ? localTime(date) : dayLabel(day);
}

// Day separators plus runs of consecutive messages from the same sender
// (within a few minutes), like any messaging app.
export function groupMessages(messages, { senderOf, timeOf, isMine }) {
  const items = [];
  let lastDay = null;
  let group = null;
  for (const m of messages) {
    const at = timeOf(m);
    const day = localDay(at);
    if (day !== lastDay) {
      items.push({ type: 'day', key: `d-${day}`, label: dayLabel(day) });
      lastDay = day;
      group = null;
    }
    const sender = senderOf(m);
    const mine = isMine(m);
    if (group && group.sender === sender && group.mine === mine && new Date(at) - new Date(group.last) < GROUP_GAP_MS) {
      group.messages.push(m);
      group.last = at;
    } else {
      group = { type: 'group', key: `g-${m.id}`, sender, mine, messages: [m], last: at };
      items.push(group);
    }
  }
  return items;
}

// Keeps a thread pinned to the bottom: jumps there when the conversation
// changes, and follows new messages unless the user scrolled up to read.
export function useStickToBottom(conversationKey, count) {
  const ref = useRef(null);
  const pinned = useRef(true);
  const onScroll = useCallback(() => {
    const el = ref.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);
  useLayoutEffect(() => {
    pinned.current = true;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conversationKey]);
  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [count]);
  const toBottom = useCallback(() => {
    pinned.current = true;
    const el = ref.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, []);
  return { ref, onScroll, toBottom };
}
