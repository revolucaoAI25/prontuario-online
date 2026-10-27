import { useEffect, useMemo, useState } from 'react';
import { Hash, MessagesSquare, Search, Send } from 'lucide-react';
import { supabase, must } from '../lib/supabase.js';
import { useInterval, useLoad } from '../lib/hooks.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { localTime } from '../lib/time.js';
import { groupMessages, listTime, useStickToBottom } from '../lib/chat.js';
import { Empty } from '../components/ui.jsx';

const LAST_CHANNEL = 'equipe.canal';
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const firstName = (name) => String(name ?? '').replace(/^(Dra?\.?)\s+/i, '').split(' ')[0];

function readLastChannel() {
  try {
    return localStorage.getItem(LAST_CHANNEL);
  } catch {
    return null;
  }
}

// Internal team groups, one per agenda/sector plus Recepção.
export function ChatPage() {
  const { staff } = useAuth();
  const toast = useToast();
  const [channelId, setChannelId] = useState(null);
  const [query, setQuery] = useState('');
  const [text, setText] = useState('');
  const [pending, setPending] = useState([]);

  const { data: channels = [], reload: reloadChannels } = useLoad(async () => {
    const [list, unread, recent] = await Promise.all([
      must(supabase.from('chat_channels').select('*').order('name')),
      must(supabase.rpc('unread_counts')),
      must(supabase.from('chat_messages').select('channel_id, body, created_at, author_id, author:staff(full_name)').order('created_at', { ascending: false }).limit(300)),
    ]);
    const counts = Object.fromEntries(unread.map((u) => [u.channel_id, Number(u.unread)]));
    const last = {};
    for (const m of recent) last[m.channel_id] ??= m;
    return list
      .map((c) => ({ ...c, unread: counts[c.id] ?? 0, last: last[c.id] ?? null }))
      .sort((a, b) => (b.last?.created_at ?? '').localeCompare(a.last?.created_at ?? '') || a.name.localeCompare(b.name));
  }, []);

  // Open the last channel used, else one with unread messages, else the most recent.
  useEffect(() => {
    if (channelId || !channels.length) return;
    const remembered = readLastChannel();
    const pick = channels.find((c) => c.unread > 0) ?? channels.find((c) => c.id === remembered) ?? channels[0];
    setChannelId(pick.id);
  }, [channels, channelId]);

  function open(id) {
    setChannelId(id);
    setText('');
    try {
      localStorage.setItem(LAST_CHANNEL, id);
    } catch {
      // not remembered in private mode
    }
  }

  const { data: messages = [], reload: reloadMessages } = useLoad(
    () => (channelId
      ? must(supabase.from('chat_messages').select('*, author:staff(full_name)').eq('channel_id', channelId).order('created_at', { ascending: false }).limit(200)).then((rows) => rows.reverse())
      : Promise.resolve([])),
    [channelId],
  );

  const shown = useMemo(() => [...messages, ...pending.filter((p) => p.channel_id === channelId)], [messages, pending, channelId]);
  const thread = useStickToBottom(channelId, shown.length);

  // Mark as read whenever the open channel shows new messages.
  useEffect(() => {
    if (!channelId || !staff) return;
    supabase.from('chat_reads').upsert({ channel_id: channelId, staff_id: staff.id, last_read_at: new Date().toISOString() })
      .then(() => { window.dispatchEvent(new Event('chat-read')); reloadChannels(); });
  }, [channelId, messages.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const channel = supabase
      .channel('chat-page')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, () => { reloadMessages(); reloadChannels(); })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [reloadMessages, reloadChannels]);
  useInterval(() => { reloadMessages(); reloadChannels(); }, 5000);

  // Shown right away; replaced by the stored message once it is saved.
  async function send() {
    const body = text.trim();
    if (!body || !channelId) return;
    const temp = { id: `tmp-${Date.now()}`, channel_id: channelId, body, author_id: staff.id, created_at: new Date().toISOString(), pending: true };
    setPending((p) => [...p, temp]);
    setText('');
    thread.toBottom();
    const { error } = await supabase.from('chat_messages').insert({ channel_id: channelId, body });
    if (error) {
      setPending((p) => p.map((m) => (m.id === temp.id ? { ...m, failed: true } : m)));
      toast.error(error);
      return;
    }
    await reloadMessages();
    setPending((p) => p.filter((m) => m.id !== temp.id));
    reloadChannels();
  }

  function retry(m) {
    setPending((p) => p.filter((x) => x.id !== m.id));
    setText(m.body);
  }

  const current = channels.find((c) => c.id === channelId);
  const listed = channels.filter((c) => !query.trim() || norm(c.name).includes(norm(query)));
  const items = groupMessages(shown, {
    senderOf: (m) => m.author_id,
    timeOf: (m) => m.created_at,
    isMine: (m) => m.author_id === staff?.id,
  });

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <h1>Equipe</h1>
          <div className="sub">Conversas internas por setor</div>
        </div>
      </header>
      <div className="chat-wrap">
        <div className="card chat-list">
          <div className="chat-list-head">
            <div className="search"><Search /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar grupo" /></div>
          </div>
          <div className="chat-items">
            {listed.map((c) => {
              const unread = c.id !== channelId ? c.unread : 0;
              const who = c.last ? (c.last.author_id === staff?.id ? 'Você' : firstName(c.last.author?.full_name) || 'Equipe') : null;
              return (
                <div key={c.id} className={`chat-item ${c.id === channelId ? 'active' : ''} ${unread ? 'has-unread' : ''}`} onClick={() => open(c.id)}>
                  <span className="channel-icon"><Hash size={16} /></span>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="row"><span className="nm grow">{c.name}</span><span className="when">{listTime(c.last?.created_at)}</span></div>
                    <div className="row">
                      <span className="snip grow"><span>{c.last ? `${who}: ${c.last.body}` : 'Nenhuma mensagem'}</span></span>
                      {unread > 0 && <span className="unread">{unread}</span>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div className="card chat-main">
          {current ? (
            <>
              <div className="chat-head">
                <span className="channel-icon"><Hash size={16} /></span>
                <div className="grow">
                  <h3>{current.name}</h3>
                  <div className="small muted">Grupo da equipe</div>
                </div>
              </div>
              <div className="thread" ref={thread.ref} onScroll={thread.onScroll}>
                {shown.length === 0 && <Empty icon={MessagesSquare}>Nenhuma mensagem ainda. Comece a conversa.</Empty>}
                {items.map((item) => (item.type === 'day' ? (
                  <div key={item.key} className="day-sep">{item.label}</div>
                ) : (
                  <div key={item.key} className={`msg-group ${item.mine ? 'out' : 'in'}`}>
                    {!item.mine && <span className="who">{item.messages[0].author?.full_name ?? 'Equipe'}</span>}
                    {item.messages.map((m) => (
                      <div key={m.id} className={`msg ${item.mine ? 'out' : 'in'} ${m.pending ? 'pending' : ''} ${m.failed ? 'failed' : ''}`}
                        onClick={m.failed ? () => retry(m) : undefined} title={m.failed ? 'Não enviada — clique para tentar de novo' : undefined}>
                        {m.body}
                        <span className="meta">{m.failed ? 'Não enviada' : localTime(m.created_at)}</span>
                      </div>
                    ))}
                  </div>
                )))}
              </div>
              <div className="chat-compose">
                <textarea
                  className="input"
                  rows={1}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                  placeholder={`Mensagem para ${current.name}`}
                  aria-label="Mensagem"
                />
                <button type="button" className="btn btn-primary" onClick={send} disabled={!text.trim()} aria-label="Enviar"><Send /></button>
              </div>
            </>
          ) : <Empty icon={MessagesSquare}>Nenhum grupo disponível.</Empty>}
        </div>
      </div>
    </div>
  );
}
