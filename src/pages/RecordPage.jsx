import { useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, CalendarPlus, CircleDollarSign, Paperclip, Pencil, Trash2, UserPen, MessageCircle } from 'lucide-react';
import { supabase, must } from '../lib/supabase.js';
import { useLoad } from '../lib/hooks.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { Avatar, Empty, Modal, StatusPill } from '../components/ui.jsx';
import { PatientForm } from '../components/PatientForm.jsx';
import { PaymentsPanel } from '../components/PaymentsPanel.jsx';
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

function Composer({ patientId, shortcuts, onSaved }) {
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
      for (const file of files) {
        const path = `${patientId}/${entry.id}/${Date.now()}-${file.name.replace(/[^\w.-]+/g, '_')}`;
        const { error } = await supabase.storage.from('prontuario').upload(path, file, { contentType: file.type || undefined });
        if (error) throw error;
        await must(supabase.from('record_attachments').insert({
          entry_id: entry.id, patient_id: patientId, storage_path: path, file_name: file.name, mime_type: file.type || null, size_bytes: file.size,
        }));
      }
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
      </div>
      <textarea
        ref={ref}
        className="textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save(); }}
        placeholder="Escreva o que foi feito…"
        style={{ minHeight: 96 }}
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

function Entry({ entry, canEdit, onChanged }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(entry.content);

  async function save() {
    const { error } = await supabase.from('record_entries').update({ content: text.trim() }).eq('id', entry.id);
    if (error) return toast.error(error);
    setEditing(false);
    onChanged();
  }

  async function remove() {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Apagar este registro do prontuário?')) return;
    const { error } = await supabase.from('record_entries').delete().eq('id', entry.id);
    if (error) return toast.error(error);
    onChanged();
  }

  async function openAttachment(att) {
    const { data, error } = await supabase.storage.from('prontuario').createSignedUrl(att.storage_path, 300);
    if (error) return toast.error(error);
    window.open(data.signedUrl, '_blank', 'noopener');
  }

  return (
    <div className="entry" data-testid="record-entry">
      <div className="entry-top">
        <span className="entry-date">{formatDay(localDay(entry.entry_at))}</span>
        {entry.author?.full_name && <span className="entry-author">{entry.author.full_name}</span>}
        {entry.legacy_id && <span className="tag">FastClinic</span>}
        {canEdit && !editing && (
          <span className="entry-actions">
            <button type="button" className="icon-btn" onClick={() => setEditing(true)} aria-label="Editar"><Pencil /></button>
            <button type="button" className="icon-btn" onClick={remove} aria-label="Apagar"><Trash2 /></button>
          </span>
        )}
      </div>
      {editing ? (
        <div className="stack" style={{ marginTop: 6 }}>
          <textarea className="textarea" value={text} onChange={(e) => setText(e.target.value)} />
          <div className="row">
            <button type="button" className="btn btn-sm" onClick={() => { setEditing(false); setText(entry.content); }}>Cancelar</button>
            <button type="button" className="btn btn-sm btn-primary" onClick={save}>Salvar</button>
          </div>
        </div>
      ) : (
        <div className="entry-text">{entry.content}</div>
      )}
      {entry.record_attachments?.length > 0 && (
        <div className="row-wrap" style={{ marginTop: 6 }}>
          {entry.record_attachments.map((a) => (
            <button key={a.id} type="button" className="btn btn-sm" onClick={() => openAttachment(a)}><Paperclip /> {a.file_name}</button>
          ))}
        </div>
      )}
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
    () => must(supabase.from('record_entries').select('*, author:staff(full_name), record_attachments(*)').eq('patient_id', patientId).order('entry_at', { ascending: false })),
    [patientId],
  );
  const sideLoad = useLoad(async () => {
    const [appointments, reminders] = await Promise.all([
      must(supabase.from('appointments').select(`${APPOINTMENT_SELECT}, agenda:agendas(name, color)`).eq('patient_id', patientId).order('starts_at', { ascending: false }).limit(40)),
      must(supabase.from('reminders').select('*, procedure:procedures(name)').eq('patient_id', patientId).eq('status', 'pendente').order('due_on')),
    ]);
    return { appointments, reminders };
  }, [patientId]);
  const { data: shortcuts = [] } = useLoad(() => must(supabase.from('note_shortcuts').select('*').eq('active', true).order('sort_order')), []);
  const { data: agendas = [] } = useLoad(loadAgendas, []);

  const patient = patientLoad.data;
  const entries = entriesLoad.data ?? [];
  const shown = useMemo(() => (filter.trim() ? entries.filter((e) => norm(e.content).includes(norm(filter.trim()))) : entries), [entries, filter]);
  const now = new Date();
  const upcoming = (sideLoad.data?.appointments ?? []).filter((a) => new Date(a.starts_at) > now && a.status !== 'cancelado').reverse();
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
            {[age != null && `${age} anos`, patient.phone, patient.cpf && `CPF ${patient.cpf}`, patient.profession].filter(Boolean).join(' · ')}
          </div>
          {patient.notes && <div className="small" style={{ marginTop: 4 }}>{patient.notes}</div>}
        </div>
        <div className="row-wrap">
          {wa && <a className="btn" href={wa} target="_blank" rel="noreferrer"><MessageCircle /> WhatsApp</a>}
          <button type="button" className="btn" onClick={() => setEditing(true)}><UserPen /> Cadastro</button>
          <button type="button" className="btn" onClick={() => setBooking(true)}><CalendarPlus /> Agendar</button>
          <button type="button" className="btn" onClick={() => setMoney(true)} aria-label="Financeiro" title="Financeiro"><CircleDollarSign /></button>
        </div>
      </div>

      <div className="record-layout">
        <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <Composer patientId={patientId} shortcuts={shortcuts} onSaved={entriesLoad.reload} />
          <div className="row" style={{ padding: '10px 18px 0' }}>
            <div className="section-title" style={{ margin: 0 }}>Prontuário · {entries.length} registros</div>
            <span className="grow" />
            <input className="input" style={{ width: 220 }} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Procurar no prontuário" />
          </div>
          <div className="timeline scroll">
            {shown.map((entry) => (
              <Entry key={entry.id} entry={entry} canEdit={isAdmin || entry.author_id === staff?.id} onChanged={entriesLoad.reload} />
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
                <div className="row"><b>{formatDay(localDay(a.starts_at))} {localTime(a.starts_at)}</b><span className="grow" /><StatusPill status={a.status} /></div>
                <div className="small muted">{a.agenda?.name}{proceduresOf(a).length ? ` · ${proceduresOf(a).map((p) => p.name).join(', ')}` : ''}</div>
              </div>
            ))}
          </div>
          <div className="card card-pad">
            <div className="section-title">Lembretes de retorno</div>
            {(sideLoad.data?.reminders ?? []).length === 0 && <div className="small muted">Nenhum pendente.</div>}
            {(sideLoad.data?.reminders ?? []).map((r) => (
              <div key={r.id} className="side-item row">
                <span className="grow">{r.procedure?.name}</span>
                <span className="small muted">{formatDay(r.due_on)}</span>
              </div>
            ))}
          </div>
          <div className="card card-pad">
            <div className="section-title">Histórico de atendimentos</div>
            {past.length === 0 && <div className="small muted">Nenhum.</div>}
            {past.map((a) => (
              <div key={a.id} className="side-item">
                <div className="row"><span className="mono">{formatDay(localDay(a.starts_at))}</span><span className="grow" /><StatusPill status={a.status} /></div>
                <div className="small muted">{a.agenda?.name}{proceduresOf(a).length ? ` · ${proceduresOf(a).map((p) => p.name).join(', ')}` : ''}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {editing && <PatientForm patient={patient} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); patientLoad.reload(); }} />}
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
