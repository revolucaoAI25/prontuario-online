import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertCircle, ArrowLeft, Bell, BellOff, Check, CheckCheck, Clock, Download, FileText, History, MessageCircle, Mic, MessageCirclePlus, Paperclip, QrCode, RotateCw, Search, Send, Trash2, X,
} from 'lucide-react';
import { supabase, must, callApi } from '../lib/supabase.js';
import { useCoalesced, useInterval, useLoad } from '../lib/hooks.js';
import { localTime } from '../lib/time.js';
import { groupMessages, listTime, useStickToBottom } from '../lib/chat.js';
import { useToast } from '../context/ToastContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { Avatar, Empty, Modal } from '../components/ui.jsx';
import { WhatsAppConnection } from '../components/WhatsAppConnection.jsx';
import { PatientPicker } from '../components/PatientPicker.jsx';

const BUCKET = 'prontuario';
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const digits = (s) => String(s ?? '').replace(/\D/g, '');
const MEDIA_LABEL = { imagem: '📷 Foto', video: '🎥 Vídeo', audio: '🎤 Áudio', documento: '📄 Documento', figurinha: 'Figurinha' };

function formatPhone(d) {
  const n = String(d ?? '').replace(/^55(?=\d{10,11}$)/, '');
  if (n.length === 11) return `(${n.slice(0, 2)}) ${n.slice(2, 7)}-${n.slice(7)}`;
  if (n.length === 10) return `(${n.slice(0, 2)}) ${n.slice(2, 6)}-${n.slice(6)}`;
  return d ?? '';
}

function formatBytes(n) {
  if (!n) return '';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

function safeName(name) {
  const clean = String(name || 'arquivo').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-');
  return clean.slice(-80) || 'arquivo';
}

async function uploadForWhatsApp(file, name = file.name) {
  if (file.size > MAX_FILE_BYTES) throw new Error(`"${name}" passa de 50 MB.`);
  const path = `whatsapp/enviadas/${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}-${safeName(name)}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type || 'application/octet-stream' });
  if (error) throw new Error(`Não foi possível enviar o arquivo: ${error.message}`);
  return { path, mime: file.type || 'application/octet-stream', nome: name, tamanho: file.size };
}

// Signed links for the media in the open conversation, refreshed before they expire.
function useSignedUrls(paths) {
  const [urls, setUrls] = useState({});
  const cache = useRef(new Map());
  const key = paths.join('|');
  useEffect(() => {
    const now = Date.now();
    const missing = paths.filter((p) => !(cache.current.get(p)?.expires > now + 60_000));
    if (missing.length === 0) {
      setUrls(Object.fromEntries(paths.map((p) => [p, cache.current.get(p).url])));
      return;
    }
    let cancelled = false;
    supabase.storage.from(BUCKET).createSignedUrls(missing, 3600).then(({ data }) => {
      for (const item of data ?? []) {
        if (item.signedUrl) cache.current.set(item.path, { url: item.signedUrl, expires: Date.now() + 3600_000 });
      }
      if (!cancelled) setUrls(Object.fromEntries(paths.filter((p) => cache.current.has(p)).map((p) => [p, cache.current.get(p).url])));
    });
    return () => { cancelled = true; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return urls;
}

function StatusIcon({ status }) {
  if (status === 'lido') return <CheckCheck className="tick read" aria-label="Lida" />;
  if (status === 'entregue') return <CheckCheck className="tick" aria-label="Entregue" />;
  if (status === 'enviado') return <Check className="tick" aria-label="Enviada" />;
  if (status === 'erro') return <AlertCircle className="tick error" aria-label="Falhou" />;
  return <Clock className="tick" aria-label="Enviando" />;
}

// A download still "pending" after a couple of minutes is stuck (it is only
// tried when the message arrives): offer to try again, like a failed one.
const isStuck = (m) => m.media_status === 'erro' || (m.media_status === 'pendente' && Date.now() - new Date(m.created_at) > 120_000);

function MediaContent({ message, url, onRetry }) {
  const kind = message.media_kind;
  if (message.media_status !== 'ok') {
    const label = isStuck(message) ? 'Não foi possível baixar o arquivo.'
      : { enviando: 'Enviando…', falhou: 'Não enviado.' }[message.media_status] ?? 'Baixando arquivo…';
    return (
      <div className="wa-file">
        <FileText />
        <div className="grow">
          <div className="nm">{MEDIA_LABEL[kind] ?? 'Arquivo'}{message.media_name ? ` · ${message.media_name}` : ''}</div>
          <div className="small">{label}</div>
        </div>
        {isStuck(message) && (
          <button type="button" className="icon-btn" onClick={onRetry} aria-label="Tentar baixar de novo" title="Tentar de novo"><RotateCw /></button>
        )}
      </div>
    );
  }
  if (!url) return <div className="wa-media-loading" />;
  if (kind === 'imagem' || kind === 'figurinha') {
    return (
      <a href={url} target="_blank" rel="noreferrer">
        <img className={kind === 'figurinha' ? 'wa-sticker' : 'wa-img'} src={url} alt={message.body ?? 'Imagem'} loading="lazy" />
      </a>
    );
  }
  if (kind === 'video') return <video className="wa-video" src={url} controls preload="metadata" />;
  if (kind === 'audio') return <audio className="wa-audio" src={url} controls preload="metadata" />;
  return (
    <a className="wa-file" href={url} target="_blank" rel="noreferrer" download={message.media_name ?? true}>
      <FileText />
      <div className="grow">
        <div className="nm">{message.media_name ?? 'Documento'}</div>
        <div className="small">{[message.media_mime?.split('/')[1]?.toUpperCase(), formatBytes(Number(message.media_size))].filter(Boolean).join(' · ')}</div>
      </div>
      <Download />
    </a>
  );
}

// Voice notes recorded in the browser (sent as WhatsApp audio messages).
function useRecorder() {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const recorder = useRef(null);
  const timer = useRef(null);

  const start = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((t) => window.MediaRecorder?.isTypeSupported?.(t));
    const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.done = new Promise((resolve) => {
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        resolve(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
      };
    });
    rec.start();
    recorder.current = rec;
    setSeconds(0);
    setRecording(true);
    timer.current = setInterval(() => setSeconds((s) => s + 1), 1000);
  }, []);

  const stop = useCallback(async () => {
    clearInterval(timer.current);
    setRecording(false);
    const rec = recorder.current;
    recorder.current = null;
    if (!rec) return null;
    rec.stop();
    return rec.done;
  }, []);

  useEffect(() => () => { clearInterval(timer.current); recorder.current?.stop(); }, []);
  return { recording, seconds, start, stop };
}

// The clinic's WhatsApp: conversations, attachments, voice notes and
// delivery status. The inbox is shared by the whole team.
const kindOfFile = (file) => (/^image\//.test(file.type) ? 'imagem' : /^video\//.test(file.type) ? 'video' : /^audio\//.test(file.type) ? 'audio' : 'documento');

// Grows with the text up to a few lines (Safari has no CSS for it).
function autoGrow(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
}
// On phones Enter is a new line (like WhatsApp); the button sends.
const touchScreen = () => window.matchMedia?.('(pointer: coarse)').matches;

function formatDelay(minutes) {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function ConversationsPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const { staff, setMute } = useAuth();
  // The open conversation lives in the address (?c=…), so the phone's back
  // button returns to the list.
  const [params, setParams] = useSearchParams();
  const jid = params.get('c');
  const openedHere = useRef(false);
  const setJid = useCallback((value) => {
    // switching conversations, closing, or arriving from a patient's record
    // replaces the entry; opening one from the list adds a step to go back
    const replace = Boolean(jid) || !value || params.has('paciente');
    if (!replace) openedHere.current = true;
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set('c', value); else next.delete('c');
      next.delete('paciente');
      return next;
    }, { replace });
  }, [jid, params, setParams]);
  // a conversation started from a patient that has no messages yet
  const [draft, setDraft] = useState(null);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]);
  const [pending, setPending] = useState([]);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef(null);
  const composer = useRef(null);
  const [syncing, setSyncing] = useState(false);
  const recorder = useRecorder();
  const [connection, setConnection] = useState(null);
  const [showConnection, setShowConnection] = useState(false);
  const checkConnection = useCallback(() => callApi('whatsapp/status').then(setConnection).catch(() => setConnection(null)), []);
  useEffect(() => { checkConnection(); }, [checkConnection]);
  const connected = connection?.estado === 'open';
  // Messages reaching the system late = the WhatsApp server lost its connection.
  const { data: health, reload: reloadHealth } = useLoad(() => must(supabase.rpc('whatsapp_health')).then((r) => r?.[0] ?? null), []);
  useInterval(() => { checkConnection(); reloadHealth(); }, 60000);
  const lateBy = health && health.late_messages >= 3 && health.delay_minutes >= 10 ? health.delay_minutes : 0;

  const { data: conversations = [], reload, loading: conversationsLoading } = useLoad(
    () => must(supabase.from('whatsapp_conversations').select('*').order('last_at', { ascending: false }).limit(300)),
    [],
  );
  const { data: messages = [], reload: reloadThread } = useLoad(
    // the latest 500 (oldest first on screen)
    () => (jid
      ? must(supabase.from('whatsapp_messages').select('*, sender:staff(full_name)').eq('remote_jid', jid).order('sent_at', { ascending: false }).limit(500)).then((rows) => rows.reverse())
      : Promise.resolve([])),
    [jid],
  );
  const urls = useSignedUrls(messages.filter((m) => m.media_status === 'ok' && m.media_path).map((m) => m.media_path));

  const refreshSoon = useCoalesced(() => { reload(); reloadThread(); }, 700);
  useEffect(() => {
    const channel = supabase
      .channel('whatsapp-mirror')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'whatsapp_messages' }, () => refreshSoon())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [refreshSoon]);
  useInterval(() => { reload(); reloadThread(); }, 30000);

  const current = draft ?? conversations.find((c) => c.remote_jid === jid);
  const conversationKey = draft ? `draft-${draft.phone_digits}` : jid;
  const shownMessages = useMemo(
    () => (draft ? [] : [...messages, ...pending.filter((p) => p.conversation === conversationKey)]),
    [draft, messages, pending, conversationKey],
  );
  const thread = useStickToBottom(conversationKey, shownMessages.length);

  // Opening a conversation (or a new message arriving in it) marks it read.
  const unreadHere = Number(current?.unread_count ?? 0);
  useEffect(() => {
    if (!jid || unreadHere === 0 || document.hidden) return;
    supabase.rpc('mark_whatsapp_read', { p_remote_jid: jid }).then(() => {
      reload();
      window.dispatchEvent(new Event('whatsapp-read'));
    });
  }, [jid, unreadHere, reload]);

  // Once the first message of a draft lands, switch to the real conversation.
  useEffect(() => {
    if (!draft) return;
    const found = conversations.find((c) => (draft.patient_id && c.patient_id === draft.patient_id) || (c.phone_digits && c.phone_digits.endsWith(draft.phone_digits.slice(-8))));
    if (found) { setDraft(null); setJid(found.remote_jid); }
  }, [conversations, draft]);

  // Opened from a patient's record or the agenda: /conversas?paciente=<id>
  const fromPatient = params.get('paciente');
  useEffect(() => {
    if (!fromPatient || conversationsLoading) return;
    supabase.from('patients').select('id, full_name, phone').eq('id', fromPatient).maybeSingle().then(({ data }) => {
      if (data) startWith(data);
      else setParams({}, { replace: true });
    });
  }, [fromPatient, conversationsLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  const name = (c) => c.patient_name ?? c.push_name ?? c.phone_digits;
  const listed = conversations.filter((c) => !query.trim() || norm(name(c)).includes(norm(query)) || String(c.phone_digits).includes(query.replace(/\D/g, '') || '#'));

  function open(c) {
    setDraft(null);
    setJid(c.remote_jid);
    setFiles([]);
  }

  // Back to the list (phones show one or the other).
  function close() {
    if (draft) { setDraft(null); return; }
    if (openedHere.current && window.history.length > 1) {
      openedHere.current = false;
      navigate(-1);
    } else {
      setJid(null);
    }
  }

  async function syncMissing() {
    setSyncing(true);
    try {
      const r = await callApi('whatsapp/sincronizar', { dias: 3 });
      toast.info(r.novas ? `${r.novas} mensage${r.novas === 1 ? 'm que faltava foi adicionada' : 'ns que faltavam foram adicionadas'}.` : 'Nenhuma mensagem faltando nos últimos 3 dias.');
      reload(); reloadThread(); reloadHealth();
    } catch (error) {
      toast.error(error);
    } finally {
      setSyncing(false);
    }
  }

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
      open(existing);
    } else {
      if (jid || params.get('paciente')) setJid(null);
      setDraft({ remote_jid: null, phone_digits: phone, patient_id: patient.id ?? null, patient_name: patient.full_name || phone });
    }
  }

  function addFiles(list) {
    const picked = [...(list ?? [])].filter((f) => f.size > 0);
    const tooBig = picked.find((f) => f.size > MAX_FILE_BYTES);
    if (tooBig) toast.error(`"${tooBig.name}" passa de 50 MB.`);
    setFiles((prev) => [...prev, ...picked.filter((f) => f.size <= MAX_FILE_BYTES)].slice(0, 10));
  }

  const target = () => ({ telefone: current.phone_digits, remote_jid: current.remote_jid, paciente_id: current.patient_id });

  // Each message shows up at once as "sending" and is replaced by the stored
  // one when the server confirms it.
  async function deliver(temp, request) {
    setPending((p) => [...p, temp]);
    thread.toBottom();
    try {
      await request();
      await Promise.all([reloadThread(), reload()]);
      setPending((p) => p.filter((m) => m.id !== temp.id));
    } catch (error) {
      setPending((p) => p.map((m) => (m.id === temp.id ? { ...m, status: 'erro', media_status: m.media_kind ? 'falhou' : null, failed: true } : m)));
      toast.error(error);
    }
  }

  const tempMessage = (fields) => ({
    id: `tmp-${Date.now()}-${Math.random()}`, conversation: conversationKey, from_me: true, status: 'pendente', sent_at: new Date().toISOString(), ...fields,
  });

  async function send() {
    const body = text.trim();
    if ((!body && files.length === 0) || !current) return;
    const to = target();
    const queue = files;
    setText('');
    setFiles([]);
    requestAnimationFrame(() => autoGrow(composer.current));
    if (queue.length === 0) {
      await deliver(tempMessage({ body }), () => callApi('whatsapp/enviar', { ...to, texto: body }));
      return;
    }
    // the text goes as the caption of the first file
    for (const [i, file] of queue.entries()) {
      const caption = i === 0 ? body : '';
      await deliver(
        tempMessage({ body: caption || null, media_kind: kindOfFile(file), media_status: 'enviando', media_name: file.name }),
        async () => callApi('whatsapp/enviar', { ...to, midia: await uploadForWhatsApp(file), texto: caption }),
      );
    }
  }

  async function toggleRecording() {
    if (!recorder.recording) {
      try {
        await recorder.start();
      } catch {
        toast.error('Não foi possível usar o microfone. Verifique a permissão do navegador.');
      }
      return;
    }
    const blob = await recorder.stop();
    if (!blob || blob.size < 1000) return;
    const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
    const to = target();
    await deliver(
      tempMessage({ body: null, media_kind: 'audio', media_status: 'enviando', media_name: 'Áudio' }),
      async () => callApi('whatsapp/enviar', { ...to, midia: await uploadForWhatsApp(blob, `audio-${Date.now()}.${ext}`), voz: true }),
    );
  }

  async function cancelRecording() {
    await recorder.stop();
  }

  async function retryMedia(id) {
    try {
      await callApi('whatsapp/midia', { id });
      reloadThread();
    } catch (error) {
      toast.error(error);
    }
  }

  function dismissFailed(m) {
    setPending((p) => p.filter((x) => x.id !== m.id));
    if (m.body && !m.media_kind) setText(m.body);
  }

  const preview = (c) => {
    const label = c.last_media_kind ? MEDIA_LABEL[c.last_media_kind] : null;
    const textPart = c.last_body ?? (label ? '' : 'Mensagem');
    return [label, textPart].filter(Boolean).join(' ');
  };
  const canSend = Boolean(text.trim() || files.length > 0);
  const items = groupMessages(shownMessages, {
    senderOf: (m) => (m.from_me ? `eu:${m.sent_by ?? ''}` : 'paciente'),
    timeOf: (m) => m.sent_at,
    isMine: (m) => m.from_me,
  });

  const threadOpen = Boolean(current);

  return (
    <div className={`page chat-page ${threadOpen ? 'thread-open' : ''}`}>
      <header className="topbar">
        <div>
          <h1>WhatsApp</h1>
          <div className="sub">Conversas com pacientes pelo número da clínica</div>
        </div>
        <div className="topbar-right">
          {connection?.configurado && (
            <button type="button" className={`btn wa-conn ${connected ? 'on' : 'off'}`} onClick={() => setShowConnection(true)} title="Conexão do WhatsApp">
              <span className="dot" /> {connected ? 'Conectado' : 'Desconectado'}
            </button>
          )}
          {/* Every computer is logged in: each person can silence it for themselves. */}
          <button type="button" className={`btn ${staff?.mute_whatsapp ? 'muted' : ''}`} onClick={() => setMute({ mute_whatsapp: !staff?.mute_whatsapp })}
            title={staff?.mute_whatsapp ? 'O som do WhatsApp está desligado só para você' : 'Desligar o som das mensagens só para você'}>
            {staff?.mute_whatsapp ? <><BellOff /> Som desligado</> : <><Bell /> Som ligado</>}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setPicking((v) => !v)}><MessageCirclePlus /> Nova conversa</button>
        </div>
      </header>
      {connection?.configurado && !connected && (
        <div className="banner row wa-banner">
          <span className="grow wa-long">O WhatsApp da clínica está desconectado. Mensagens novas não chegam nem saem até conectar de novo.</span>
          <span className="grow wa-short">WhatsApp desconectado.</span>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setShowConnection(true)}><QrCode /> Conectar</button>
        </div>
      )}
      {connected && lateBy > 0 && (
        <div className="banner row wa-banner">
          <span className="grow wa-long">
            As mensagens estão chegando aqui com atraso (até {formatDelay(lateBy)}). O servidor do WhatsApp está perdendo a conexão.
            Até normalizar, confira as conversas mais recentes no celular da clínica.
          </span>
          <span className="grow wa-short">Mensagens chegando com atraso (até {formatDelay(lateBy)}). Confira no celular da clínica.</span>
          <button type="button" className="btn btn-sm wa-long" disabled={syncing} onClick={syncMissing}><History /> {syncing ? 'Buscando…' : 'Buscar o que faltou'}</button>
        </div>
      )}
      {showConnection && (
        <Modal title="Conexão do WhatsApp" onClose={() => { setShowConnection(false); checkConnection(); }}>
          <WhatsAppConnection onStatus={setConnection} autoConnect={!connected} />
          {connected && (
            <div className="wa-sync">
              <div className="small muted grow">Alguma mensagem que está no celular não apareceu aqui? O sistema busca no servidor do WhatsApp as dos últimos 3 dias que faltarem.</div>
              <button type="button" className="btn btn-sm" disabled={syncing} onClick={syncMissing}><History /> {syncing ? 'Buscando…' : 'Buscar mensagens que faltaram'}</button>
            </div>
          )}
        </Modal>
      )}
      {picking && (
        <Modal title="Nova conversa" onClose={() => setPicking(false)}>
          <div className="small muted" style={{ marginBottom: 10 }}>Escolha o paciente. A conversa usa o celular do cadastro.</div>
          <PatientPicker value={null} onChange={startWith} autoFocus />
        </Modal>
      )}
      <div className={`chat-wrap ${threadOpen ? 'thread-open' : ''}`}>
        <div className="card chat-list">
          <div className="chat-list-head">
            <div className="search"><Search /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar por nome ou telefone" /></div>
          </div>
          <div className="chat-items">
            {listed.map((c) => {
              const unread = Number(c.unread_count);
              return (
                <div key={c.remote_jid} className={`chat-item ${!draft && c.remote_jid === jid ? 'active' : ''} ${unread ? 'has-unread' : ''}`} onClick={() => open(c)}>
                  <Avatar name={name(c)} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="row"><span className="nm grow">{name(c)}</span><span className="when">{listTime(c.last_at)}</span></div>
                    <div className="row">
                      <span className="snip grow">
                        {c.last_from_me && <StatusIcon status={c.last_status} />}
                        <span>{preview(c)}</span>
                      </span>
                      {unread > 0 && <span className="unread">{unread > 99 ? '99+' : unread}</span>}
                    </div>
                  </div>
                </div>
              );
            })}
            {conversations.length === 0 && (
              <Empty icon={MessageCircle}>Nenhuma conversa ainda. As mensagens do WhatsApp da clínica aparecem aqui.</Empty>
            )}
            {conversations.length > 0 && listed.length === 0 && <Empty icon={Search}>Nenhuma conversa encontrada.</Empty>}
          </div>
        </div>
        <div
          className={`card chat-main ${dragging ? 'dragging' : ''}`}
          onDragOver={(e) => { if (current && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false); }}
          onDrop={(e) => { e.preventDefault(); setDragging(false); if (current) addFiles(e.dataTransfer.files); }}
        >
          {current ? (
            <>
              <div className="chat-head">
                <button type="button" className="icon-btn chat-back" onClick={close} aria-label="Voltar para as conversas"><ArrowLeft /></button>
                <Avatar name={name(current)} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <h3>{name(current)}</h3>
                  <div className="small muted tnum">{formatPhone(current.phone_digits)}{current.patient_name && current.push_name && current.push_name !== current.patient_name ? ` · no WhatsApp: ${current.push_name}` : ''}</div>
                </div>
                {current.patient_id && <Link className="btn btn-sm" to={`/prontuario/${current.patient_id}`} title="Abrir o prontuário"><FileText /> <span className="lbl">Prontuário</span></Link>}
              </div>
              <div className="thread" ref={thread.ref} onScroll={thread.onScroll}>
                {shownMessages.length === 0 && <Empty icon={MessageCircle}>Nenhuma mensagem ainda. Escreva abaixo para começar.</Empty>}
                {items.map((item) => (item.type === 'day' ? (
                  <div key={item.key} className="day-sep">{item.label}</div>
                ) : (
                  <div key={item.key} className={`msg-group ${item.mine ? 'out' : 'in'}`}>
                    {item.mine && item.messages[0].sender?.full_name && <span className="who">{item.messages[0].sender.full_name}</span>}
                    {item.messages.map((m) => (
                      <div key={m.id} className={`msg ${m.from_me ? 'out' : 'in'} ${m.media_kind ? 'has-media' : ''} ${m.pending && !m.failed ? 'pending' : ''} ${m.failed ? 'failed' : ''} ${m.deleted_at ? 'deleted' : ''}`}
                        onClick={m.failed ? () => dismissFailed(m) : undefined} title={m.failed ? 'Não enviada — clique para remover' : undefined}>
                        {m.deleted_at && <div className="msg-note"><Trash2 /> Apagada no WhatsApp{m.from_me ? '' : ' pelo paciente'}</div>}
                        {m.media_kind && <MediaContent message={m} url={urls[m.media_path]} onRetry={() => retryMedia(m.id)} />}
                        {m.body ? <div className="msg-text">{m.body}</div> : !m.media_kind && <i className="msg-unsupported">Tipo de mensagem que o sistema não mostra. Veja no celular da clínica.</i>}
                        <span className="meta">
                          {m.edited_at && <span className="edited">editada · </span>}
                          {m.failed ? 'Não enviada' : localTime(m.sent_at)}
                          {m.from_me && !m.failed && <StatusIcon status={m.status} />}
                        </span>
                      </div>
                    ))}
                  </div>
                )))}
              </div>
              {dragging && <div className="drop-hint">Solte para anexar</div>}
              {files.length > 0 && (
                <div className="wa-attachments">
                  {files.map((f, i) => (
                    <span key={`${f.name}${i}`} className="wa-attachment">
                      <Paperclip /> {f.name} <span className="muted">{formatBytes(f.size)}</span>
                      <button type="button" className="icon-btn" onClick={() => setFiles((prev) => prev.filter((x) => x !== f))} aria-label={`Remover ${f.name}`}><X /></button>
                    </span>
                  ))}
                </div>
              )}
              <div className="chat-compose">
                <input ref={fileInput} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
                {recorder.recording ? (
                  <>
                    <button type="button" className="icon-btn" onClick={cancelRecording} aria-label="Descartar áudio" title="Descartar"><Trash2 /></button>
                    <div className="wa-recording grow"><span className="rec-dot" /> Gravando {Math.floor(recorder.seconds / 60)}:{String(recorder.seconds % 60).padStart(2, '0')}</div>
                    <button type="button" className="btn btn-primary" style={{ width: 'auto', padding: '0 14px' }} onClick={toggleRecording} aria-label="Enviar áudio"><Send /> Enviar</button>
                  </>
                ) : (
                  <>
                    <button type="button" className="icon-btn" onClick={() => fileInput.current?.click()} aria-label="Anexar arquivo" title="Anexar foto, vídeo ou documento"><Paperclip /></button>
                    <textarea
                      ref={composer}
                      className="input"
                      rows={1}
                      value={text}
                      maxLength={4096}
                      onChange={(e) => { setText(e.target.value); autoGrow(e.target); }}
                      onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); addFiles(e.clipboardData.files); } }}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !touchScreen()) { e.preventDefault(); send(); } }}
                      placeholder={files.length ? 'Legenda (opcional)' : 'Mensagem'}
                      aria-label="Mensagem de WhatsApp"
                    />
                    {canSend ? (
                      <button type="button" className="btn btn-primary" onClick={send} aria-label="Enviar"><Send /></button>
                    ) : (
                      <button type="button" className="btn btn-primary" onClick={toggleRecording} aria-label="Gravar áudio" title="Gravar áudio"><Mic /></button>
                    )}
                  </>
                )}
              </div>
            </>
          ) : <Empty icon={MessageCircle}>Selecione uma conversa.</Empty>}
        </div>
      </div>
    </div>
  );
}
