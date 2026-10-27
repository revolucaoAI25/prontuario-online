import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import {
  CalendarDays, Users, FileText, Wallet, Package, MessagesSquare, MessageCircle, BellRing, Settings, LogOut,
} from 'lucide-react';
import { supabase } from '../lib/supabase.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useInterval } from '../lib/hooks.js';
import { playChime } from '../lib/sound.js';
import { Avatar } from './ui.jsx';

const NAV = [
  { to: '/agenda', label: 'Agenda', icon: CalendarDays },
  { to: '/pacientes', label: 'Pacientes', icon: Users },
  { to: '/prontuarios', label: 'Prontuários', icon: FileText },
  { to: '/comunicacao', label: 'Equipe', icon: MessagesSquare, badge: 'chat' },
  { to: '/conversas', label: 'WhatsApp', icon: MessageCircle, badge: 'whatsapp' },
  { to: '/lembretes', label: 'Lembretes', icon: BellRing },
  { to: '/estoque', label: 'Estoque', icon: Package },
  { to: '/financeiro', label: 'Financeiro', icon: Wallet, admin: true },
  { to: '/configuracoes', label: 'Ajustes', icon: Settings, admin: true },
];

// Unread internal-chat messages, with a chime when new ones arrive. Uses
// realtime when available and polling as a fallback.
function useUnreadChat() {
  const [unread, setUnread] = useState(0);
  const last = useRef(null);

  async function refresh() {
    const { data } = await supabase.rpc('unread_counts');
    const total = (data ?? []).reduce((sum, r) => sum + Number(r.unread), 0);
    if (last.current !== null && total > last.current) playChime();
    last.current = total;
    setUnread(total);
  }

  useEffect(() => {
    refresh();
    const channel = supabase
      .channel('chat-unread')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, () => refresh())
      .subscribe();
    window.addEventListener('chat-read', refresh);
    return () => {
      supabase.removeChannel(channel);
      window.removeEventListener('chat-read', refresh);
    };
  }, []);
  useInterval(refresh, 10000);
  return unread;
}

// Patient messages nobody on the team has opened yet (shared inbox), with the
// same chime when new ones arrive.
function useUnreadWhatsApp() {
  const [unread, setUnread] = useState(0);
  const last = useRef(null);

  async function refresh() {
    const { data } = await supabase.from('whatsapp_conversations').select('unread_count').gt('unread_count', 0);
    const total = (data ?? []).reduce((sum, r) => sum + Number(r.unread_count), 0);
    if (last.current !== null && total > last.current) playChime();
    last.current = total;
    setUnread(total);
  }

  useEffect(() => {
    refresh();
    const channel = supabase
      .channel('whatsapp-unread')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'whatsapp_messages' }, () => refresh())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'whatsapp_reads' }, () => refresh())
      .subscribe();
    window.addEventListener('whatsapp-read', refresh);
    return () => {
      supabase.removeChannel(channel);
      window.removeEventListener('whatsapp-read', refresh);
    };
  }, []);
  useInterval(refresh, 15000);
  return unread;
}

export function Layout() {
  const { staff, isAdmin, signOut } = useAuth();
  const unread = { chat: useUnreadChat(), whatsapp: useUnreadWhatsApp() };
  return (
    <div className="app">
      <aside className="rail">
        <NavLink to="/agenda" className="logo" title="Everson Rezeck · Medicina Estética">
          <img src="/brand/logo-mark.png" alt="Everson Rezeck" />
        </NavLink>
        <nav className="rail-nav">
          {NAV.filter((item) => !item.admin || isAdmin).map(({ to, label, icon: Icon, badge }) => (
            <NavLink key={to} to={to} className={({ isActive }) => `rail-btn ${isActive ? 'active' : ''}`}>
              <Icon />
              <span className="label">{label}</span>
              {badge && unread[badge] > 0 && <span className="badge">{unread[badge] > 99 ? '99+' : unread[badge]}</span>}
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
        <Outlet />
      </main>
    </div>
  );
}
