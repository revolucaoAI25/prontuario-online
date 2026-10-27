import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileText, MessageCircle, Search } from 'lucide-react';
import { supabase, must } from '../lib/supabase.js';
import { useInterval, useLoad } from '../lib/hooks.js';
import { formatDay, localDay, localTime } from '../lib/time.js';
import { whatsappLink } from '../lib/format.js';
import { Avatar, Empty } from '../components/ui.jsx';

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Read-only mirror of the clinic's WhatsApp (Evolution API). Replies are sent
// from WhatsApp itself to avoid number bans.
export function ConversationsPage() {
  const [jid, setJid] = useState(null);
  const [query, setQuery] = useState('');
  const threadRef = useRef(null);

  const { data: conversations = [], reload } = useLoad(
    () => must(supabase.from('whatsapp_conversations').select('*').order('last_at', { ascending: false }).limit(300)),
    [],
  );
  const { data: messages = [], reload: reloadThread } = useLoad(
    () => (jid ? must(supabase.from('whatsapp_messages').select('*').eq('remote_jid', jid).order('sent_at').limit(500)) : Promise.resolve([])),
    [jid],
  );

  useEffect(() => {
    const channel = supabase
      .channel('whatsapp-mirror')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'whatsapp_messages' }, () => { reload(); reloadThread(); })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [reload, reloadThread]);
  useInterval(() => { reload(); reloadThread(); }, 15000);
  useEffect(() => { threadRef.current?.scrollTo(0, threadRef.current.scrollHeight); }, [messages.length, jid]);

  const name = (c) => c.patient_name ?? c.push_name ?? c.phone_digits;
  const shown = conversations.filter((c) => !query.trim() || norm(name(c)).includes(norm(query)) || String(c.phone_digits).includes(query.replace(/\D/g, '') || '#'));
  const current = conversations.find((c) => c.remote_jid === jid);
  let lastDay = null;

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <h1>WhatsApp</h1>
          <div className="sub">Conversas com pacientes — somente leitura</div>
        </div>
        <div className="topbar-right">
          <div className="search"><Search /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar conversa" /></div>
        </div>
      </header>
      <div className="chat-wrap">
        <div className="card chat-list">
          <div className="chat-items">
            {shown.map((c) => (
              <div key={c.remote_jid} className={`chat-item ${c.remote_jid === jid ? 'active' : ''}`} onClick={() => setJid(c.remote_jid)}>
                <Avatar name={name(c)} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row"><span className="nm grow">{name(c)}</span><span className="small muted">{localDay(c.last_at) === localDay() ? localTime(c.last_at) : formatDay(localDay(c.last_at))}</span></div>
                  <div className="snip">{c.last_from_me ? 'Você: ' : ''}{c.last_body ?? '(mídia)'}</div>
                </div>
              </div>
            ))}
            {conversations.length === 0 && (
              <Empty>Nenhuma conversa ainda. Elas aparecem aqui quando a Evolution API estiver conectada.</Empty>
            )}
          </div>
        </div>
        <div className="card chat-main">
          {current ? (
            <>
              <div className="chat-head">
                <Avatar name={name(current)} />
                <div className="grow">
                  <h3 style={{ fontSize: 15 }}>{name(current)}</h3>
                  <div className="small muted mono">{current.phone_digits}</div>
                </div>
                {current.patient_id && <Link className="btn btn-sm" to={`/prontuario/${current.patient_id}`}><FileText /> Prontuário</Link>}
                {whatsappLink(current.phone_digits) && (
                  <a className="btn btn-sm btn-primary" href={whatsappLink(current.phone_digits)} target="_blank" rel="noreferrer"><MessageCircle /> Responder no WhatsApp</a>
                )}
              </div>
              <div className="thread" ref={threadRef}>
                {messages.map((m) => {
                  const d = localDay(m.sent_at);
                  const sep = d !== lastDay ? <div key={`d${m.id}`} className="day-sep">{d === localDay() ? 'Hoje' : formatDay(d)}</div> : null;
                  lastDay = d;
                  return [
                    sep,
                    <div key={m.id} className={`msg ${m.from_me ? 'out' : 'in'}`}>
                      {m.body ?? <i>({m.message_type ?? 'mídia'})</i>}
                      <span className="meta">{localTime(m.sent_at)}</span>
                    </div>,
                  ];
                })}
              </div>
              <div className="chat-compose"><div className="banner grow">Somente leitura. Para responder, use o WhatsApp da clínica.</div></div>
            </>
          ) : <Empty>Selecione uma conversa.</Empty>}
        </div>
      </div>
    </div>
  );
}
