import { Suspense, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import {
  CalendarDays, Users, FileText, Wallet, Package, MessagesSquare, MessageCircle, BellRing, Settings, LogOut, ClipboardList, Contact, Megaphone,
} from 'lucide-react';
import { supabase } from '../lib/supabase.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useInterval } from '../lib/hooks.js';
import { installSoundUnlock, notify, playChime } from '../lib/sound.js';
import { CHANNEL_SELECT, channelColor } from '../lib/channels.js';
import { isMobileDevice } from '../lib/device.js';
import { Avatar } from './ui.jsx';

const NAV = [
  { to: '/agenda', label: 'Agenda', icon: CalendarDays },
  { to: '/pacientes', label: 'Pacientes', icon: Users },
  { to: '/prontuarios', label: 'Prontuários', icon: FileText },
  { to: '/comunicacao', label: 'Equipe', icon: MessagesSquare, badge: 'chat' },
  { to: '/conversas', label: 'WhatsApp', icon: MessageCircle, badge: 'whatsapp' },
  { to: '/lembretes', label: 'Lembretes', icon: BellRing },
  { to: '/estoque', label: 'Estoque', icon: Package },
  { to: '/administrativo', label: 'Administrativo', icon: ClipboardList, reception: true, badge: 'tasks' },
  { to: '/financeiro', label: 'Financeiro', icon: Wallet, reception: true, desktop: true },
  { to: '/pessoal', label: 'Pessoal', icon: Contact, admin: true },
  { to: '/configuracoes', label: 'Ajustes', icon: Settings, admin: true },
  { to: '/disparos', label: 'Disparos', icon: Megaphone, superadmin: true },
];

// Unread internal-chat messages per group, with the group's color. Every new
// message from someone else chimes (unless this person muted the team chat)
// and, with the app in the background, shows a system notification.
function useUnreadChat(staffId, muted, mutedChannels) {
  const [unread, setUnread] = useState([]);
  const last = useRef(null);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  // Groups this person silenced: no sound, no notification, no menu bubble.
  const silencedRef = useRef(new Set());
  silencedRef.current = new Set(mutedChannels ?? []);

  // Groups (names, colors) change rarely: read again at most every 5 minutes.
  const channelsRef = useRef({ at: 0, list: [] });
  async function loadChannels() {
    if (Date.now() - channelsRef.current.at < 300_000) return channelsRef.current.list;
    const { data } = await supabase.from('chat_channels').select(CHANNEL_SELECT);
    channelsRef.current = { at: Date.now(), list: data ?? [] };
    return channelsRef.current.list;
  }

  async function refresh() {
    const [{ data: counts }, channels] = await Promise.all([
      supabase.rpc('unread_counts'),
      loadChannels(),
    ]);
    const list = (counts ?? []).filter((r) => Number(r.unread) > 0 && !silencedRef.current.has(r.channel_id)).map((r) => {
      const channel = (channels ?? []).find((c) => c.id === r.channel_id);
      return { id: r.channel_id, count: Number(r.unread), color: channelColor(channel), name: channel?.name };
    });
    const total = list.reduce((sum, r) => sum + r.count, 0);
    if (last.current !== null && total > last.current && !mutedRef.current) playChime();
    last.current = total;
    setUnread(list);
  }

  useEffect(() => {
    refresh();
    const channel = supabase
      .channel('chat-unread')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, ({ new: m }) => {
        if (m?.author_id && m.author_id !== staffId && !mutedRef.current && !silencedRef.current.has(m.channel_id)) {
          playChime();
          notify('Nova mensagem da equipe', m.body, () => { window.location.assign('/comunicacao'); });
        }
        refresh();
      })
      .subscribe();
    window.addEventListener('chat-read', refresh);
    return () => {
      supabase.removeChannel(channel);
      window.removeEventListener('chat-read', refresh);
    };
  }, [staffId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Silencing or unsilencing a group updates the menu right away.
  const silencedKey = (mutedChannels ?? []).join();
  useEffect(() => { if (last.current !== null) { last.current = null; refresh(); } }, [silencedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useInterval(refresh, 30000);
  return unread;
}

// Patient messages nobody on the team has opened yet (shared inbox), with the
// same chime when new ones arrive, unless this person muted WhatsApp.
function useUnreadWhatsApp(muted) {
  const [unread, setUnread] = useState(0);
  const last = useRef(null);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  async function refresh() {
    const { data, error } = await supabase.rpc('whatsapp_unread_total');
    if (error) return;
    const total = Number(data ?? 0);
    if (last.current !== null && total > last.current && !mutedRef.current) playChime();
    last.current = total;
    setUnread(total);
  }

  useEffect(() => {
    refresh();
    const channel = supabase
      .channel('whatsapp-unread')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'whatsapp_messages' }, ({ new: m }) => {
        if (m && !m.from_me && !mutedRef.current) {
          playChime();
          notify(`WhatsApp · ${m.push_name ?? 'paciente'}`, m.body ?? 'Nova mensagem', () => { window.location.assign('/conversas'); });
        }
        refresh();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'whatsapp_reads' }, () => refresh())
      .subscribe();
    window.addEventListener('whatsapp-read', refresh);
    return () => {
      supabase.removeChannel(channel);
      window.removeEventListener('whatsapp-read', refresh);
    };
  }, []);
  useInterval(refresh, 30000);
  return unread;
}

// Administrativo: tasks whose reminder time has come. Each one alerts once per
// computer (sound and notification); the count stays on the menu until done.
function useDueTasks(enabled) {
  const [due, setDue] = useState(0);

  async function refresh() {
    if (!enabled) return;
    const { data } = await supabase.from('admin_tasks').select('id, title').is('done_at', null).lte('remind_at', new Date().toISOString());
    const list = data ?? [];
    setDue(list.length);
    let seen;
    try { seen = new Set(JSON.parse(localStorage.getItem('tarefas.avisadas') ?? '[]')); } catch { seen = new Set(); }
    const fresh = list.filter((t) => !seen.has(t.id));
    if (fresh.length) {
      playChime();
      notify('Lembrete', fresh.map((t) => t.title).join(' · '), () => { window.location.assign('/administrativo'); });
      try { localStorage.setItem('tarefas.avisadas', JSON.stringify([...seen, ...fresh.map((t) => t.id)].slice(-300))); } catch { /* alerts again */ }
    }
  }

  useEffect(() => {
    refresh();
    window.addEventListener('tasks-changed', refresh);
    return () => window.removeEventListener('tasks-changed', refresh);
  }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  useInterval(refresh, 60000);
  return due;
}

// Unread bubbles: one per group with news, in the group's color, slightly
// overlapping (big enough to see from across the room).
function ChatBubbles({ list }) {
  if (list.length === 0) return null;
  const shown = list.slice(0, 3);
  return (
    <span className="bubbles" title={list.map((c) => `${c.name}: ${c.count}`).join(' · ')}>
      {shown.map((c) => <span key={c.id} className="bubble" style={{ background: c.color }}>{c.count > 99 ? '99+' : c.count}</span>)}
    </span>
  );
}

export function Layout() {
  const { staff, isAdmin, isReception, isSuperAdmin, signOut } = useAuth();
  const chat = useUnreadChat(staff?.id, staff?.mute_chat, staff?.chat_muted_channels);
  const unread = { whatsapp: useUnreadWhatsApp(staff?.mute_whatsapp), tasks: useDueTasks(isReception) };
  const mobile = isMobileDevice();
  useEffect(() => { installSoundUnlock(); }, []);
  // Financeiro on a phone: only the administrator.
  const visible = (item) => (item.superadmin ? isSuperAdmin : item.admin ? isAdmin : item.reception ? isReception : true) && !(item.desktop && mobile && !isAdmin);
  return (
    <div className="app">
      <aside className="rail">
        <NavLink to="/agenda" className="logo" title="Everson Rezeck · Medicina Estética">
          <img src="/brand/logo-mark.png" alt="Everson Rezeck" />
        </NavLink>
        <nav className="rail-nav">
          {NAV.filter(visible).map(({ to, label, icon: Icon, badge }) => (
            <NavLink key={to} to={to} className={({ isActive }) => `rail-btn ${isActive ? 'active' : ''}`}>
              <Icon />
              <span className="label">{label}</span>
              {badge === 'chat' && <ChatBubbles list={chat} />}
              {badge && badge !== 'chat' && unread[badge] > 0 && (
                <span className={`bubbles single ${badge}`}><span className="bubble">{unread[badge] > 99 ? '99+' : unread[badge]}</span></span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="rail-user">
          <Avatar name={staff?.full_name} size="sm" />
          <div className="name">{staff?.full_name?.replace(/^(Dra?\.?)\s+/i, '').split(' ')[0]}</div>
          <button type="button" className="rail-btn" onClick={signOut} title="Sair">
            <LogOut />
            <span className="label">Sair</span>
          </button>
        </div>
      </aside>
      <main className="main">
        <Suspense fallback={<div className="page-loading">Carregando…</div>}><Outlet /></Suspense>
      </main>
    </div>
  );
}
