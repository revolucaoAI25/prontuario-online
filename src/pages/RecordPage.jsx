import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, CalendarPlus, CircleDollarSign, MapPin, Maximize2, Minimize2, PanelRightClose, PanelRightOpen, Paperclip, Pencil, Trash2, UserPen, MessageCircle, X } from 'lucide-react';
import { supabase, must } from '../lib/supabase.js';
import { useLoad } from '../lib/hooks.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { Avatar, Empty, Modal, StatusPill } from '../components/ui.jsx';
import { PatientForm } from '../components/PatientForm.jsx';
import { PaymentsPanel } from '../components/PaymentsPanel.jsx';
import { PatientReminders } from '../components/PatientReminders.jsx';
import { AppointmentModal } from './agenda/AppointmentModal.jsx';
import { APPOINTMENT_SELECT, loadAgendas, proceduresOf } from './agenda/agendaData.js';
import { ageFrom, formatDay, localDay, localTime, zonedToUtc } from '../lib/time.js';
import { whatsappLink } from '../lib/format.js';

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Inserts a shortcut at the cursor, joining with " + " like the clinic's
// existing notes ("L + H + Botox").
export function insertShortcut(value, selectionStart, selectionEnd, text) {
  const before = value.slice(0, selectionStart);
  const after = value.slice(selectionEnd);
  const trimmed = before.replace(/[ \t]+$/, '');
  let prefix = before;
  if (trimmed && !/[\n+]$/.test(trimmed)) prefix = `${trimmed} + `;
  else if (/\+$/.test(trimmed)) prefix = `${trimmed} `;
  return { value: prefix + text + after, caret: prefix.length + text.length };
}

function Composer({ patientId, shortcuts, onSaved, focus, onToggleFocus }) {
  const toast = useToast();
  const ref = useRef(null);
  const [text, setText] = useState('');
  const [date, setDate] = useState(localDay());
  const [files, setFiles] = useState([]);
  const [saving, setSaving] = useState(false);

  function shortcut(item) {
    const el = ref.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const next = insertShortcut(text, start, end, item.insert_text);
    setText(next.value);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(next.caret, next.caret);
    });
  }

  async function save() {
    if (!text.trim()) return;
    setSaving(true);
    try {
      const at = date === localDay() ? new Date() : zonedToUtc(date, '12:00');
      const entry = await must(
        supabase.from('record_entries').insert({ patient_id: patientId, entry_at: at.toISOString(), content: text.trim() }).select('id').single(),
      );
      await uploadAttachments(patientId, entry.id, files);
      setText('');
      setFiles([]);
      setDate(localDay());
      onSaved();
    } catch (error) {
      toast.error(error);
    } finally {
      setSaving(false);
    }
  }

  const procedures = shortcuts.filter((s) => s.kind === 'procedimento');
  const products = shortcuts.filter((s) => s.kind === 'produto');

  return (
    <div className="composer">
      <div className="row" style={{ marginBottom: 8 }}>
        <div className="section-title" style={{ margin: 0 }}>Novo registro</div>
        <span className="grow" />
        <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 160 }} aria-label="Data do registro" />
        <button type="button" className="icon-btn" onClick={onToggleFocus} title={focus ? 'Sair da tela cheia (Esc)' : 'Tela cheia'} aria-label={focus ? 'Sair da tela cheia' : 'Tela cheia'}>
          {focus ? <Minimize2 /> : <Maximize2 />}
        </button>
      </div>
      <textarea
        ref={ref}
        className="textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save(); }}
        placeholder="Escreva o que foi feito…"
        style={{ minHeight: focus ? '34vh' : 96 }}
        aria-label="Texto do registro"
      />
      <div className="shortcut-row">
        {procedures.map((s) => (
          <button key={s.id} type="button" className="shortcut" title={s.insert_text} onClick={() => shortcut(s)}>{s.label}</button>
        ))}
        {products.length > 0 && <span className="small muted" style={{ margin: '0 4px 0 8px' }}>Produtos</span>}
        {products.map((s) => (
          <button key={s.id} type="button" className="shortcut produto" title={s.insert_text} onClick={() => shortcut(s)}>{s.label}</button>
        ))}
        <span className="grow" />
        <label className="btn btn-sm">
          <Paperclip /> Anexar
          <input type="file" multiple hidden onChange={(e) => setFiles([...files, ...e.target.files])} />
        </label>
        <button type="button" className="btn btn-primary" disabled={saving || !text.trim()} onClick={save}>Salvar registro</button>
      </div>
      {files.length > 0 && <div className="row-wrap">{files.map((f) => <span key={f.name} className="tag brand">{f.name}</span>)}</div>}
    </div>
  );
}

async function uploadAttachments(patientId, entryId, files) {
  for (const file of files) {
    const path = `${patientId}/${entryId}/${Date.now()}-${file.name.replace(/[^\w.-]+/g, '_')}`;
    const { error } = await supabase.storage.from('prontuario').upload(path, file, { contentType: file.type || undefined });
    if (error) throw error;
    await must(supabase.from('record_attachments').insert({
      entry_id: entryId, patient_id: patientId, storage_path: path, file_name: file.name, mime_type: file.type || null, size_bytes: file.size,
    }));
  }
}

const firstName = (name) => String(name ?? '').replace(/^(Dra?\.?)\s+/i, '').split(' ')[0];
const stamp = (at) => `${formatDay(localDay(at))} às ${localTime(at)}`;

// Earlier versions of an edited entry (kept for the record).
function Revisions({ entryId }) {
  const { data: revisions } = useLoad(
    () => must(supabase.from('record_entry_revisions')
      .select('*, writer:staff!record_entry_revisions_written_by_fkey(full_name), replacer:staff!record_entry_revisions_replaced_by_fkey(full_name)')
      .eq('entry_id', entryId).order('replaced_at', { ascending: false })),
    [entryId],
  );
  if (!revisions) return <div className="small muted">Carregando…</div>;
  return (
    <div className="revisions">
      {revisions.map((r) => (
        <div key={r.id} className="revision">
          <div className="small muted">
            Versão de {formatDay(localDay(r.entry_at))}
            {r.writer?.full_name ? ` · escrita por ${r.writer.full_name}` : ''}
            {' · '}substituída por {r.replacer?.full_name ?? 'alguém da equipe'} em {stamp(r.replaced_at)}
          </div>
          <div className="entry-text">{r.content}</div>
        </div>
      ))}
    </div>
  );
}

// sameDay: another entry of the same day is right above it (several sectors
// writing on the same visit), so it shows a "+" instead of repeating the date.
// Anyone on the team corrects an entry (text, date, attachments); every
// change is kept. Deleting is for its author and the administrator.
function Entry({ entry, canDelete, onChanged, sameDay = false }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(entry.content);
  const [date, setDate] = useState(localDay(entry.entry_at));
  const [newFiles, setNewFiles] = useState([]);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState(false);

  function startEditing() {
    setText(entry.content);
    setDate(localDay(entry.entry_at));
    setNewFiles([]);
    setEditing(true);
  }

  async function save() {
    if (!text.trim()) return toast.error('O registro não pode ficar vazio.');
    setSaving(true);
    try {
      const changes = {};
      if (text.trim() !== entry.content) changes.content = text.trim();
      // a new date keeps the time of day it was written
      if (date && date !== localDay(entry.entry_at)) changes.entry_at = zonedToUtc(date, localTime(entry.entry_at)).toISOString();
      if (Object.keys(changes).length) await must(supabase.from('record_entries').update(changes).eq('id', entry.id));
      if (newFiles.length) await uploadAttachments(entry.patient_id, entry.id, newFiles);
      setEditing(false);
      toast.info('Registro atualizado.');
      onChanged();
    } catch (error) {
      toast.error(error);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Apagar este registro do prontuário?')) return;
    const { error } = await supabase.from('record_entries').delete().eq('id', entry.id);
    if (error) return toast.error(error);
    onChanged();
  }

  async function removeAttachment(att) {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Tirar o anexo "${att.file_name}" deste registro?`)) return;
    const { error } = await supabase.from('record_attachments').delete().eq('id', att.id);
    if (error) return toast.error(error);
    onChanged();
  }

  async function openAttachment(att) {
    const { data, error } = await supabase.storage.from('prontuario').createSignedUrl(att.storage_path, 300);
    if (error) return toast.error(error);
    window.open(data.signedUrl, '_blank', 'noopener');
  }

  return (
    <div className={`entry ${sameDay ? 'same-day' : ''} ${editing ? 'editing' : ''}`} data-testid="record-entry">
      <div className="entry-top">
        {!sameDay && !editing && <span className="entry-date">{formatDay(localDay(entry.entry_at))}</span>}
        {!editing && (
          <span className="entry-actions">
            <button type="button" className="btn btn-ghost btn-xs" onClick={startEditing} title="Corrigir este registro"><Pencil /> Editar</button>
            {canDelete && <button type="button" className="icon-btn" onClick={remove} aria-label="Apagar" title="Apagar"><Trash2 /></button>}
          </span>
        )}
      </div>
      {editing ? (
        <div className="stack entry-edit">
          <div className="row">
            <span className="small muted">Data</span>
            <input className="input" type="date" value={date} max={localDay()} onChange={(e) => setDate(e.target.value)} style={{ width: 160 }} aria-label="Data do registro" />
          </div>
          <textarea className="textarea" value={text} onChange={(e) => setText(e.target.value)} autoFocus style={{ minHeight: 120 }}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save(); if (e.key === 'Escape') setEditing(false); }} aria-label="Texto do registro" />
          {(entry.record_attachments?.length > 0 || newFiles.length > 0) && (
            <div className="row-wrap">
              {entry.record_attachments?.map((a) => (
                <span key={a.id} className="tag">
                  <Paperclip /> {a.file_name}
                  <button type="button" className="tag-x" onClick={() => removeAttachment(a)} aria-label={`Tirar ${a.file_name}`}><X /></button>
                </span>
              ))}
              {newFiles.map((f, i) => (
                <span key={`${f.name}${i}`} className="tag brand">
                  <Paperclip /> {f.name}
                  <button type="button" className="tag-x" onClick={() => setNewFiles((prev) => prev.filter((x) => x !== f))} aria-label={`Tirar ${f.name}`}><X /></button>
                </span>
              ))}
            </div>
          )}
          <div className="row">
            <label className="btn btn-sm">
              <Paperclip /> Anexar
              <input type="file" multiple hidden onChange={(e) => { setNewFiles((prev) => [...prev, ...e.target.files]); e.target.value = ''; }} />
            </label>
            <span className="grow" />
            <button type="button" className="btn btn-sm" onClick={() => setEditing(false)}>Cancelar</button>
            <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={save}>{saving ? 'Salvando…' : 'Salvar alteração'}</button>
          </div>
        </div>
      ) : (
        <div className="entry-text">{sameDay && <span className="entry-plus" title={`Também em ${formatDay(localDay(entry.entry_at))}`}>+ </span>}{entry.content}</div>
      )}
      {!editing && entry.record_attachments?.length > 0 && (
        <div className="row-wrap" style={{ marginTop: 6 }}>
          {entry.record_attachments.map((a) => (
            <button key={a.id} type="button" className="btn btn-sm" onClick={() => openAttachment(a)}><Paperclip /> {a.file_name}</button>
          ))}
        </div>
      )}
      {!editing && entry.edited_at && (
        <div className="entry-edited">
          Editado por {firstName(entry.editor?.full_name) || 'alguém da equipe'} em {stamp(entry.edited_at)} ·{' '}
          <button type="button" className="link-btn" onClick={() => setHistory((v) => !v)}>{history ? 'esconder versões anteriores' : 'ver versões anteriores'}</button>
        </div>
      )}
      {history && !editing && <Revisions entryId={entry.id} />}
    </div>
  );
}

export function RecordPage() {
  const { patientId } = useParams();
  const navigate = useNavigate();
  const { staff, isAdmin } = useAuth();
  const [editing, setEditing] = useState(false);
  const [money, setMoney] = useState(false);
  const [booking, setBooking] = useState(false);
  const [filter, setFilter] = useState('');

  const patientLoad = useLoad(() => must(supabase.from('patients').select('*').eq('id', patientId).single()), [patientId]);
  const entriesLoad = useLoad(
    () => must(supabase.from('record_entries').select('*, record_attachments(*), editor:staff!record_entries_edited_by_fkey(full_name)').eq('patient_id', patientId).order('entry_at', { ascending: false })),
    [patientId],
  );
  const sideLoad = useLoad(async () => {
    const appointments = await must(supabase.from('appointments').select(`${APPOINTMENT_SELECT}, agenda:agendas(name, color)`).eq('patient_id', patientId).order('starts_at', { ascending: false }).limit(40));
    return { appointments };
  }, [patientId]);
  const { data: shortcuts = [] } = useLoad(() => must(supabase.from('note_shortcuts').select('*').eq('active', true).order('sort_order')), []);
  const { data: agendas = [] } = useLoad(loadAgendas, []);

  // Full-screen notepad: only the record, the whole screen (Esc leaves).
  const [focus, setFocus] = useState(false);
  // The side panel (visits, returns) is mostly for the reception: it starts
  // hidden so the record takes the whole width; each computer remembers.
  const [side, setSide] = useState(() => {
    try { return localStorage.getItem('prontuario.painel') === 'aberto'; } catch { return false; }
  });
  function toggleSide() {
    setSide((open) => {
      try { localStorage.setItem('prontuario.painel', open ? 'fechado' : 'aberto'); } catch { /* not remembered */ }
      return !open;
    });
  }
  useEffect(() => {
    document.body.classList.toggle('focus-mode', focus);
    if (!focus) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
      setFocus(false);
    };
    const onFullscreen = () => !document.fullscreenElement && setFocus(false);
    window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onFullscreen);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFullscreen);
      document.body.classList.remove('focus-mode');
    };
  }, [focus]);
  function toggleFocus() {
    if (!focus) document.documentElement.requestFullscreen?.().catch(() => {});
    else if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    setFocus(!focus);
  }

  const patient = patientLoad.data;
  const entries = entriesLoad.data ?? [];
  const shown = useMemo(() => (filter.trim() ? entries.filter((e) => norm(e.content).includes(norm(filter.trim()))) : entries), [entries, filter]);
  const now = new Date();
  const upcoming = (sideLoad.data?.appointments ?? []).filter((a) => new Date(a.starts_at) > now && !a.removed_at).reverse();
  const past = (sideLoad.data?.appointments ?? []).filter((a) => new Date(a.starts_at) <= now);

  if (patientLoad.error) return <Empty>Paciente não encontrado.</Empty>;
  if (!patient) return <Empty>Carregando…</Empty>;
  const age = ageFrom(patient.birth_date);
  const wa = whatsappLink(patient.phone);

  return (
    <div className="page">
      <div className="card record-head">
        <button type="button" className="icon-btn" onClick={() => navigate(-1)} aria-label="Voltar"><ArrowLeft /></button>
        <Avatar name={patient.full_name} size="lg" />
        <div className="grow" style={{ minWidth: 200 }}>
          <h1>{patient.full_name}</h1>
          <div className="small muted">
            {age != null ? <b className="ink">{age} anos</b> : <button type="button" className="link-btn" onClick={() => setEditing(true)}>sem data de nascimento</button>}
            {[patient.phone, patient.cpf && `CPF ${patient.cpf}`, patient.profession].filter(Boolean).map((x) => <span key={x}> · {x}</span>)}
          </div>
          <div className="small muted row" style={{ gap: 4, marginTop: 2 }}>
            <MapPin size={13} />
            {patient.address ? <span className="ink">{patient.address}</span> : <button type="button" className="link-btn" onClick={() => setEditing(true)}>sem endereço</button>}
          </div>
          {patient.notes && <div className="small" style={{ marginTop: 4 }}>{patient.notes}</div>}
        </div>
        <div className="row-wrap">
          {wa && <Link className="btn" to={`/conversas?paciente=${patient.id}`}><MessageCircle /> WhatsApp</Link>}
          <button type="button" className="btn" onClick={() => setEditing(true)}><UserPen /> Cadastro</button>
          <button type="button" className="btn" onClick={() => setBooking(true)}><CalendarPlus /> Agendar</button>
          <button type="button" className="btn" onClick={() => setMoney(true)} aria-label="Financeiro" title="Financeiro"><CircleDollarSign /></button>
        </div>
      </div>

      <div className={`record-layout ${focus ? 'focus' : ''} ${side ? '' : 'no-side'}`}>
        <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <Composer patientId={patientId} shortcuts={shortcuts} onSaved={entriesLoad.reload} focus={focus} onToggleFocus={toggleFocus} />
          <div className="row record-head" style={{ padding: '10px 18px 0' }}>
            <div className="section-title" style={{ margin: 0 }}>Prontuário · {entries.length} registros</div>
            <span className="grow" />
            <input className="input record-search" style={{ width: 220 }} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Procurar no prontuário" />
            {!focus && (
              <button type="button" className="btn btn-sm" onClick={toggleSide} title={side ? 'Esconder o painel lateral' : 'Mostrar agendamentos e retornos'}>
                {side ? <PanelRightClose /> : <PanelRightOpen />} {side ? 'Esconder painel' : 'Agendamentos e retornos'}
              </button>
            )}
          </div>
          <div className="timeline scroll">
            {shown.map((entry, i) => (
              <Entry key={entry.id} entry={entry} canDelete={isAdmin || (entry.author_id && entry.author_id === staff?.id)} onChanged={entriesLoad.reload}
                sameDay={i > 0 && localDay(shown[i - 1].entry_at) === localDay(entry.entry_at)} />
            ))}
            {entriesLoad.data && shown.length === 0 && <Empty>{filter ? 'Nada encontrado.' : 'Nenhum registro ainda.'}</Empty>}
          </div>
        </div>

        <div className="stack scroll">
          <div className="card card-pad">
            <div className="section-title">Próximos agendamentos</div>
            {upcoming.length === 0 && <div className="small muted">Nenhum.</div>}
            {upcoming.map((a) => (
              <div key={a.id} className="side-item">
                <div className="row"><b>{formatDay(localDay(a.starts_at))} {localTime(a.starts_at)}</b><span className="grow" /><StatusPill status={a.status} removed={a.removed_at} /></div>
                <div className="small muted">{a.agenda?.name}{proceduresOf(a).length ? ` · ${proceduresOf(a).map((p) => p.name).join(', ')}` : ''}</div>
              </div>
            ))}
          </div>
          <PatientReminders patientId={patientId} />
          <div className="card card-pad">
            <div className="section-title">Histórico de atendimentos</div>
            {past.length === 0 && <div className="small muted">Nenhum.</div>}
            {past.map((a) => (
              <div key={a.id} className="side-item">
                <div className="row"><span className="mono">{formatDay(localDay(a.starts_at))}</span><span className="grow" /><StatusPill status={a.status} removed={a.removed_at} /></div>
                <div className="small muted">{a.agenda?.name}{proceduresOf(a).length ? ` · ${proceduresOf(a).map((p) => p.name).join(', ')}` : ''}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {editing && <PatientForm patient={patient} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); patientLoad.reload(); }} onDeleted={() => navigate('/pacientes', { replace: true })} />}
      {money && (
        <Modal title={`Financeiro · ${patient.full_name}`} onClose={() => setMoney(false)}>
          <PaymentsPanel patientId={patient.id} />
        </Modal>
      )}
      {booking && agendas.length > 0 && (
        <AppointmentModal
          agendas={agendas}
          prefill={{ day: localDay(), time: '09:00', agendaId: agendas[0].id, patient }}
          onClose={() => setBooking(false)}
          onSaved={() => { setBooking(false); sideLoad.reload(); }}
        />
      )}
    </div>
  );
}
