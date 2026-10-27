import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle, Check, CheckCheck, Clock, Download, FileText, Mic, MessageCirclePlus, Paperclip, RotateCw, Search, Send, Square, Trash2, X,
} from 'lucide-react';
import { supabase, must, callApi } from '../lib/supabase.js';
import { useInterval, useLoad } from '../lib/hooks.js';
import { formatDay, localDay, localTime } from '../lib/time.js';
import { useToast } from '../context/ToastContext.jsx';
import { Avatar, Empty } from '../components/ui.jsx';
import { PatientPicker } from '../components/PatientPicker.jsx';

const BUCKET = 'prontuario';
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const digits = (s) => String(s ?? '').replace(/\D/g, '');
const MEDIA_LABEL = { imagem: '📷 Foto', video: '🎥 Vídeo', audio: '🎤 Áudio', documento: '📄 Documento', figurinha: 'Figurinha' };

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

function MediaContent({ message, url, onRetry }) {
  const kind = message.media_kind;
  if (message.media_status !== 'ok') {
    return (
      <div className="wa-file">
        <FileText />
        <div className="grow">
          <div className="nm">{MEDIA_LABEL[kind] ?? 'Arquivo'}{message.media_name ? ` · ${message.media_name}` : ''}</div>
          <div className="small">{message.media_status === 'erro' ? 'Não foi possível baixar o arquivo.' : 'Baixando arquivo…'}</div>
        </div>
        {message.media_status === 'erro' && (
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

// The clinic's WhatsApp (Evolution API): conversations, attachments, voice
// notes and delivery status. The inbox is shared by the whole team.
export function ConversationsPage() {
  const toast = useToast();
  const [jid, setJid] = useState(null);
  // a conversation started from a patient that has no messages yet
  const [draft, setDraft] = useState(null);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const threadRef = useRef(null);
  const fileInput = useRef(null);
  const recorder = useRecorder();

  const { data: conversations = [], reload } = useLoad(
    () => must(supabase.from('whatsapp_conversations').select('*').order('last_at', { ascending: false }).limit(300)),
    [],
  );
  const { data: messages = [], reload: reloadThread } = useLoad(
    () => (jid ? must(supabase.from('whatsapp_messages').select('*, sender:staff(full_name)').eq('remote_jid', jid).order('sent_at').limit(500)) : Promise.resolve([])),
    [jid],
  );
  const urls = useSignedUrls(messages.filter((m) => m.media_status === 'ok' && m.media_path).map((m) => m.media_path));

  useEffect(() => {
    const channel = supabase
      .channel('whatsapp-mirror')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'whatsapp_messages' }, () => { reload(); reloadThread(); })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [reload, reloadThread]);
  useInterval(() => { reload(); reloadThread(); }, 15000);
  useEffect(() => { threadRef.current?.scrollTo(0, threadRef.current.scrollHeight); }, [messages.length, jid]);

  const current = draft ?? conversations.find((c) => c.remote_jid === jid);

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

  const name = (c) => c.patient_name ?? c.push_name ?? c.phone_digits;
  const shown = conversations.filter((c) => !query.trim() || norm(name(c)).includes(norm(query)) || String(c.phone_digits).includes(query.replace(/\D/g, '') || '#'));
  let lastDay = null;

  function open(c) {
    setDraft(null);
    setJid(c.remote_jid);
    setFiles([]);
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
      setJid(null);
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

  async function send() {
    const body = text.trim();
    if ((!body && files.length === 0) || sending || !current) return;
    setSending(true);
    try {
      if (files.length === 0) {
        await callApi('whatsapp/enviar', { ...target(), texto: body });
      } else {
        // the text goes as the caption of the first file
        for (const [i, file] of files.entries()) {
          const midia = await uploadForWhatsApp(file);
          await callApi('whatsapp/enviar', { ...target(), midia, texto: i === 0 ? body : '' });
          setFiles((prev) => prev.filter((f) => f !== file));
        }
      }
      setText('');
      setFiles([]);
      reload();
      reloadThread();
    } catch (error) {
      toast.error(error);
    } finally {
      setSending(false);
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
    setSending(true);
    try {
      const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
      const midia = await uploadForWhatsApp(blob, `audio-${Date.now()}.${ext}`);
      await callApi('whatsapp/enviar', { ...target(), midia, voz: true });
      reloadThread();
      reload();
    } catch (error) {
      toast.error(error);
    } finally {
      setSending(false);
    }
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

  const preview = (c) => {
    const label = c.last_media_kind ? MEDIA_LABEL[c.last_media_kind] : null;
    const textPart = c.last_body ?? (label ? '' : '(mensagem)');
    return [label, textPart].filter(Boolean).join(' ');
  };
  const canSend = (text.trim() || files.length > 0) && !sending;

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
            {shown.map((c) => {
              const unread = Number(c.unread_count);
              return (
                <div key={c.remote_jid} className={`chat-item ${!draft && c.remote_jid === jid ? 'active' : ''} ${unread ? 'has-unread' : ''}`} onClick={() => open(c)}>
                  <Avatar name={name(c)} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="row"><span className="nm grow">{name(c)}</span><span className="small muted">{localDay(c.last_at) === localDay() ? localTime(c.last_at) : formatDay(localDay(c.last_at))}</span></div>
                    <div className="row">
                      <span className="snip grow">
                        {c.last_from_me && <StatusIcon status={c.last_status} />}
                        {preview(c)}
                      </span>
                      {unread > 0 && <span className="unread">{unread > 99 ? '99+' : unread}</span>}
                    </div>
                  </div>
                </div>
              );
            })}
            {conversations.length === 0 && (
              <Empty>Nenhuma conversa ainda. Elas aparecem aqui quando a Evolution API estiver conectada.</Empty>
            )}
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
                    <div key={m.id} className={`msg ${m.from_me ? 'out' : 'in'} ${m.media_kind ? 'has-media' : ''}`}>
                      {m.media_kind && <MediaContent message={m} url={urls[m.media_path]} onRetry={() => retryMedia(m.id)} />}
                      {m.body ? <div className="msg-text">{m.body}</div> : !m.media_kind && <i>(mensagem não suportada)</i>}
                      <span className="meta">
                        {m.sender?.full_name ? `${m.sender.full_name} · ` : ''}{localTime(m.sent_at)}
                        {m.from_me && <StatusIcon status={m.status} />}
                      </span>
                    </div>,
                  ];
                })}
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
              <div className="chat-compose wa-compose">
                <input ref={fileInput} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
                {recorder.recording ? (
                  <>
                    <button type="button" className="icon-btn" onClick={cancelRecording} aria-label="Descartar áudio" title="Descartar"><Trash2 /></button>
                    <div className="wa-recording grow"><span className="rec-dot" /> Gravando {Math.floor(recorder.seconds / 60)}:{String(recorder.seconds % 60).padStart(2, '0')}</div>
                    <button type="button" className="btn btn-primary" onClick={toggleRecording} aria-label="Enviar áudio"><Square /> Enviar</button>
                  </>
                ) : (
                  <>
                    <button type="button" className="icon-btn" onClick={() => fileInput.current?.click()} aria-label="Anexar arquivo" title="Anexar foto, vídeo ou documento"><Paperclip /></button>
                    <textarea
                      className="input"
                      rows={1}
                      value={text}
                      maxLength={4096}
                      onChange={(e) => setText(e.target.value)}
                      onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); addFiles(e.clipboardData.files); } }}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                      placeholder={files.length ? 'Legenda (opcional)' : 'Mensagem'}
                      aria-label="Mensagem de WhatsApp"
                    />
                    {canSend || files.length ? (
                      <button type="button" className="btn btn-primary" onClick={send} disabled={!canSend} aria-label="Enviar"><Send /></button>
                    ) : (
                      <button type="button" className="btn btn-primary" onClick={toggleRecording} disabled={sending} aria-label="Gravar áudio" title="Gravar áudio"><Mic /></button>
                    )}
                  </>
                )}
              </div>
            </>
          ) : <Empty>Selecione uma conversa.</Empty>}
        </div>
      </div>
    </div>
  );
}
