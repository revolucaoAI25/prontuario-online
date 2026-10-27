import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileText, MessageCirclePlus, Search, Send, X } from 'lucide-react';
import { supabase, must, callApi } from '../lib/supabase.js';
import { useInterval, useLoad } from '../lib/hooks.js';
import { formatDay, localDay, localTime } from '../lib/time.js';
import { useToast } from '../context/ToastContext.jsx';
import { Avatar, Empty } from '../components/ui.jsx';
import { PatientPicker } from '../components/PatientPicker.jsx';

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const digits = (s) => String(s ?? '').replace(/\D/g, '');

// Mirror of the clinic's WhatsApp (Evolution API). Messages can be sent from
// here too, but the team is encouraged to answer from the phone.
export function ConversationsPage() {
  const toast = useToast();
  const [jid, setJid] = useState(null);
  // a conversation started from a patient that has no messages yet
  const [draft, setDraft] = useState(null);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const threadRef = useRef(null);

  const { data: conversations = [], reload } = useLoad(
    () => must(supabase.from('whatsapp_conversations').select('*').order('last_at', { ascending: false }).limit(300)),
    [],
  );
  const { data: messages = [], reload: reloadThread } = useLoad(
    () => (jid ? must(supabase.from('whatsapp_messages').select('*, sender:staff(full_name)').eq('remote_jid', jid).order('sent_at').limit(500)) : Promise.resolve([])),
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

  // Once the first message of a draft lands, switch to the real conversation.
  useEffect(() => {
    if (!draft) return;
    const found = conversations.find((c) => (draft.patient_id && c.patient_id === draft.patient_id) || (c.phone_digits && c.phone_digits.endsWith(draft.phone_digits.slice(-8))));
    if (found) { setDraft(null); setJid(found.remote_jid); }
  }, [conversations, draft]);

  const name = (c) => c.patient_name ?? c.push_name ?? c.phone_digits;
  const shown = conversations.filter((c) => !query.trim() || norm(name(c)).includes(norm(query)) || String(c.phone_digits).includes(query.replace(/\D/g, '') || '#'));
  const current = draft ?? conversations.find((c) => c.remote_jid === jid);
  let lastDay = null;

  function startWith(patient) {
    if (!patient) return;
    const phone = digits(patient.phone);
    if (phone.length < 10) {
      toast.error('Esse paciente não tem um celular válido cadastrado.');
      return;
    }
    setPicking(false);
    const existing = conversations.find((c) => (patient.id && c.patient_id === patient.id) || (c.phone_digits && c.phone_digits.endsWith(phone.slice(-8))));
    if (existing) {
      setDraft(null);
      setJid(existing.remote_jid);
    } else {
      setJid(null);
      setDraft({ remote_jid: null, phone_digits: phone, patient_id: patient.id ?? null, patient_name: patient.full_name || phone });
    }
  }

  async function send() {
    const body = text.trim();
    if (!body || sending || !current) return;
    setSending(true);
    try {
      await callApi('whatsapp/enviar', { texto: body, telefone: current.phone_digits, remote_jid: current.remote_jid, paciente_id: current.patient_id });
      setText('');
      reload();
      reloadThread();
    } catch (error) {
      toast.error(error);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <h1>WhatsApp</h1>
          <div className="sub">Conversas com pacientes pelo número da clínica</div>
        </div>
        <div className="topbar-right">
          <div className="search"><Search /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar conversa" /></div>
          <button type="button" className="btn btn-primary" onClick={() => setPicking((v) => !v)}><MessageCirclePlus /> Nova conversa</button>
        </div>
      </header>
      {picking && (
        <div className="card card-pad" style={{ marginBottom: 12 }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <div className="section-title grow" style={{ margin: 0 }}>Nova conversa com paciente</div>
            <button type="button" className="icon-btn" onClick={() => setPicking(false)} aria-label="Fechar"><X /></button>
          </div>
          <PatientPicker value={null} onChange={startWith} autoFocus />
        </div>
      )}
      <div className="chat-wrap">
        <div className="card chat-list">
          <div className="chat-items">
            {shown.map((c) => (
              <div key={c.remote_jid} className={`chat-item ${!draft && c.remote_jid === jid ? 'active' : ''}`} onClick={() => { setDraft(null); setJid(c.remote_jid); }}>
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
              </div>
              <div className="thread" ref={threadRef}>
                {draft && <Empty>Nenhuma mensagem com este paciente ainda.</Empty>}
                {!draft && messages.map((m) => {
                  const d = localDay(m.sent_at);
                  const sep = d !== lastDay ? <div key={`d${m.id}`} className="day-sep">{d === localDay() ? 'Hoje' : formatDay(d)}</div> : null;
                  lastDay = d;
                  return [
                    sep,
                    <div key={m.id} className={`msg ${m.from_me ? 'out' : 'in'}`}>
                      {m.body ?? <i>({m.message_type ?? 'mídia'})</i>}
                      <span className="meta">{m.sender?.full_name ? `${m.sender.full_name} · ` : ''}{localTime(m.sent_at)}</span>
                    </div>,
                  ];
                })}
              </div>
              <div className="wa-compose">
                <div className="small muted">Sai pelo número da clínica. Sempre que possível, prefira responder pelo celular.</div>
                <div className="chat-compose" style={{ borderTop: 'none', padding: 0 }}>
                  <textarea
                    className="input"
                    rows={2}
                    value={text}
                    maxLength={4096}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                    placeholder="Mensagem (Enter envia, Shift+Enter quebra linha)"
                    aria-label="Mensagem de WhatsApp"
                  />
                  <button type="button" className="btn btn-primary" onClick={send} disabled={sending || !text.trim()} aria-label="Enviar"><Send /></button>
                </div>
              </div>
            </>
          ) : <Empty>Selecione uma conversa.</Empty>}
        </div>
      </div>
    </div>
  );
}
