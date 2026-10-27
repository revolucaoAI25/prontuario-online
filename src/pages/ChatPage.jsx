import { useEffect, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import { supabase, must } from '../lib/supabase.js';
import { useInterval, useLoad } from '../lib/hooks.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { formatDay, localDay, localTime } from '../lib/time.js';
import { Empty } from '../components/ui.jsx';

// Internal team groups, one per agenda/sector plus Recepção.
export function ChatPage() {
  const { staff } = useAuth();
  const toast = useToast();
  const [channelId, setChannelId] = useState(null);
  const [text, setText] = useState('');
  const threadRef = useRef(null);

  const { data: channels = [], reload: reloadChannels } = useLoad(async () => {
    const [list, unread] = await Promise.all([
      must(supabase.from('chat_channels').select('*').order('name')),
      must(supabase.rpc('unread_counts')),
    ]);
    const counts = Object.fromEntries(unread.map((u) => [u.channel_id, Number(u.unread)]));
    return list.map((c) => ({ ...c, unread: counts[c.id] ?? 0 }));
  }, []);

  useEffect(() => {
    if (!channelId && channels.length) setChannelId(channels[0].id);
  }, [channels, channelId]);

  const { data: messages = [], reload: reloadMessages } = useLoad(
    () => (channelId
      ? must(supabase.from('chat_messages').select('*, author:staff(full_name)').eq('channel_id', channelId).order('created_at', { ascending: false }).limit(200)).then((rows) => rows.reverse())
      : Promise.resolve([])),
    [channelId],
  );

  // Mark as read whenever the open channel shows new messages.
  useEffect(() => {
    if (!channelId || !staff) return;
    supabase.from('chat_reads').upsert({ channel_id: channelId, staff_id: staff.id, last_read_at: new Date().toISOString() })
      .then(() => { window.dispatchEvent(new Event('chat-read')); reloadChannels(); });
    threadRef.current?.scrollTo(0, threadRef.current.scrollHeight);
  }, [channelId, messages.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const channel = supabase
      .channel('chat-page')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, () => { reloadMessages(); reloadChannels(); })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [reloadMessages, reloadChannels]);
  useInterval(() => { reloadMessages(); reloadChannels(); }, 5000);

  async function send() {
    const body = text.trim();
    if (!body || !channelId) return;
    setText('');
    const { error } = await supabase.from('chat_messages').insert({ channel_id: channelId, body });
    if (error) {
      setText(body);
      return toast.error(error);
    }
    reloadMessages();
  }

  const current = channels.find((c) => c.id === channelId);
  let lastDay = null;

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <h1>Equipe</h1>
          <div className="sub">Avisos internos por setor — com aviso sonoro para mensagens novas</div>
        </div>
      </header>
      <div className="chat-wrap">
        <div className="card chat-list">
          <div className="chat-items">
            {channels.map((c) => (
              <div key={c.id} className={`chat-item ${c.id === channelId ? 'active' : ''}`} onClick={() => setChannelId(c.id)}>
                <span className="avatar">#</span>
                <div className="grow nm">{c.name}</div>
                {c.unread > 0 && c.id !== channelId && <span className="unread">{c.unread}</span>}
              </div>
            ))}
          </div>
        </div>
        <div className="card chat-main">
          {current ? (
            <>
              <div className="chat-head"><h3 style={{ fontSize: 15 }}># {current.name}</h3></div>
              <div className="thread" ref={threadRef}>
                {messages.length === 0 && <Empty>Nenhuma mensagem ainda.</Empty>}
                {messages.map((m) => {
                  const d = localDay(m.created_at);
                  const sep = d !== lastDay ? <div key={`d${m.id}`} className="day-sep">{d === localDay() ? 'Hoje' : formatDay(d)}</div> : null;
                  lastDay = d;
                  const mine = m.author_id === staff?.id;
                  return [
                    sep,
                    <div key={m.id} className={`msg ${mine ? 'out' : 'in'}`}>
                      {!mine && <span className="who">{m.author?.full_name ?? '—'}</span>}
                      {m.body}
                      <span className="meta">{localTime(m.created_at)}</span>
                    </div>,
                  ];
                })}
              </div>
              <div className="chat-compose">
                <input
                  className="input"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && send()}
                  placeholder={`Mensagem para #${current.name}`}
                  aria-label="Mensagem"
                />
                <button type="button" className="btn btn-primary" onClick={send} aria-label="Enviar"><Send /></button>
              </div>
            </>
          ) : <Empty>Nenhum grupo disponível.</Empty>}
        </div>
      </div>
    </div>
  );
}
