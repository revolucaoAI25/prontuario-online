import { useState } from 'react';
import { BellRing, Check, NotebookPen, Pencil, Pin, PinOff, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { supabase, must } from '../lib/supabase.js';
import { useLoad } from '../lib/hooks.js';
import { useToast } from '../context/ToastContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { formatDateTime, localDay, localTime, zonedToUtc } from '../lib/time.js';
import { Empty } from '../components/ui.jsx';

const changed = () => window.dispatchEvent(new Event('tasks-changed'));

function TaskForm({ task, onDone }) {
  const toast = useToast();
  const [title, setTitle] = useState(task?.title ?? '');
  const [day, setDay] = useState(task?.remind_at ? localDay(task.remind_at) : '');
  const [time, setTime] = useState(task?.remind_at ? localTime(task.remind_at) : '09:00');
  const [notes, setNotes] = useState(task?.notes ?? '');

  async function save() {
    if (!title.trim()) return toast.error('Escreva a tarefa.');
    const row = { title: title.trim(), notes: notes.trim() || null, remind_at: day ? zonedToUtc(day, time || '09:00').toISOString() : null };
    const { error } = task?.id
      ? await supabase.from('admin_tasks').update(row).eq('id', task.id)
      : await supabase.from('admin_tasks').insert(row);
    if (error) return toast.error(error);
    if (!task?.id) { setTitle(''); setNotes(''); setDay(''); }
    changed();
    return onDone();
  }

  return (
    <div className="task-form">
      <input className="input" autoFocus={Boolean(task)} value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} placeholder="Nova tarefa, ex.: manutenção do ar-condicionado" />
      <div className="row-wrap">
        <label className="small muted" htmlFor={`d-${task?.id ?? 'new'}`}>Lembrar em</label>
        <input id={`d-${task?.id ?? 'new'}`} className="input" type="date" style={{ width: 160 }} value={day} onChange={(e) => setDay(e.target.value)} />
        <input className="input" type="time" style={{ width: 110 }} value={time} onChange={(e) => setTime(e.target.value)} disabled={!day} aria-label="Hora do lembrete" />
        {day && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDay('')}>Sem lembrete</button>}
        <span className="grow" />
        {task?.id && <button type="button" className="btn btn-sm" onClick={onDone}><X /> Cancelar</button>}
        <button type="button" className="btn btn-sm btn-primary" onClick={save}>{task?.id ? 'Salvar' : <><Plus /> Adicionar</>}</button>
      </div>
      {(task?.id || title) && <textarea className="textarea" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Detalhes (opcional)" />}
    </div>
  );
}

function Tasks() {
  const toast = useToast();
  const { isAdmin, staff } = useAuth();
  const [editing, setEditing] = useState(null);
  const [showDone, setShowDone] = useState(false);
  const { data: tasks = [], reload } = useLoad(
    () => must(supabase.from('admin_tasks').select('*, author:staff!admin_tasks_created_by_fkey(full_name), doer:staff!admin_tasks_done_by_fkey(full_name)')
      .order('done_at', { ascending: false, nullsFirst: true }).order('remind_at', { ascending: true, nullsFirst: false }).limit(300)),
    [],
  );
  const now = new Date();
  const open = tasks.filter((t) => !t.done_at);
  const groups = [
    ['Atrasadas e para agora', open.filter((t) => t.remind_at && new Date(t.remind_at) <= now), 'late'],
    ['Próximas', open.filter((t) => t.remind_at && new Date(t.remind_at) > now), ''],
    ['Sem data', open.filter((t) => !t.remind_at), ''],
  ];
  const done = tasks.filter((t) => t.done_at);

  async function update(task, changes) {
    const { error } = await supabase.from('admin_tasks').update(changes).eq('id', task.id);
    if (error) return toast.error(error);
    changed();
    return reload();
  }
  async function remove(task) {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Apagar a tarefa "${task.title}"?`)) return;
    const { error } = await supabase.from('admin_tasks').delete().eq('id', task.id);
    if (error) return toast.error(error);
    changed();
    reload();
  }

  const row = (t) => (editing === t.id ? (
    <div key={t.id} className="task editing"><TaskForm task={t} onDone={() => { setEditing(null); reload(); }} /></div>
  ) : (
    <div key={t.id} className={`task ${t.done_at ? 'done' : ''}`}>
      <button type="button" className="task-check" onClick={() => update(t, t.done_at ? { done_at: null, done_by: null } : { done_at: new Date().toISOString(), done_by: staff?.id })}
        aria-label={t.done_at ? 'Reabrir' : 'Concluir'} title={t.done_at ? 'Reabrir' : 'Concluir'}>
        {t.done_at ? <RotateCcw /> : <Check />}
      </button>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="task-title">{t.title}</div>
        {t.notes && <div className="small muted task-notes">{t.notes}</div>}
        <div className="small muted">
          {t.remind_at && <span className={!t.done_at && new Date(t.remind_at) <= now ? 'task-due' : ''}><BellRing size={12} /> {formatDateTime(t.remind_at)} · </span>}
          {t.done_at ? `Feita por ${t.doer?.full_name ?? '—'} em ${formatDateTime(t.done_at)}` : `Criada por ${t.author?.full_name ?? '—'}`}
        </div>
      </div>
      {!t.done_at && <button type="button" className="icon-btn ghost" onClick={() => setEditing(t.id)} aria-label="Editar" title="Editar"><Pencil /></button>}
      {(isAdmin || !t.done_at) && <button type="button" className="icon-btn ghost" onClick={() => remove(t)} aria-label="Apagar tarefa" title="Apagar"><Trash2 /></button>}
    </div>
  ));

  return (
    <div className="card card-pad">
      <div className="section-title"><BellRing size={13} /> Tarefas e lembretes</div>
      <TaskForm onDone={reload} />
      {open.length === 0 && <div className="small muted" style={{ padding: '12px 0' }}>Nenhuma tarefa aberta. Com data, o sistema avisa (som e notificação) quando chegar a hora.</div>}
      {groups.map(([title, list, tone]) => list.length > 0 && (
        <div key={title} className="task-group">
          <div className={`task-group-title ${tone}`}>{title} · {list.length}</div>
          {list.map(row)}
        </div>
      ))}
      {done.length > 0 && (
        <div className="task-group">
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowDone(!showDone)}>{showDone ? 'Esconder' : 'Mostrar'} concluídas ({done.length})</button>
          {showDone && done.slice(0, 50).map(row)}
        </div>
      )}
    </div>
  );
}

function NoteCard({ note, onChanged }) {
  const toast = useToast();
  const [editing, setEditing] = useState(!note.id);
  const [title, setTitle] = useState(note.title ?? '');
  const [body, setBody] = useState(note.body ?? '');

  async function save() {
    if (!title.trim() && !body.trim()) return toast.error('Escreva alguma coisa na anotação.');
    const row = { title: title.trim() || null, body: body.trim() };
    const { error } = note.id
      ? await supabase.from('admin_notes').update(row).eq('id', note.id)
      : await supabase.from('admin_notes').insert(row);
    if (error) return toast.error(error);
    setEditing(false);
    return onChanged();
  }
  async function remove() {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Apagar esta anotação?')) return;
    const { error } = await supabase.from('admin_notes').delete().eq('id', note.id);
    if (error) return toast.error(error);
    onChanged();
  }
  async function togglePin() {
    const { error } = await supabase.from('admin_notes').update({ pinned: !note.pinned }).eq('id', note.id);
    if (error) return toast.error(error);
    onChanged();
  }

  if (editing) {
    return (
      <div className="card card-pad note editing">
        <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Título (opcional)" />
        <textarea className="textarea" rows={6} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Anotação livre: telefones de fornecedores, senhas do Wi-Fi da sala, combinados..." />
        <div className="row">
          <span className="grow" />
          <button type="button" className="btn btn-sm" onClick={() => (note.id ? setEditing(false) : onChanged())}>Cancelar</button>
          <button type="button" className="btn btn-sm btn-primary" onClick={save}>Salvar</button>
        </div>
      </div>
    );
  }
  return (
    <div className={`card card-pad note ${note.pinned ? 'pinned' : ''}`}>
      <div className="row">
        <b className="grow">{note.title || 'Anotação'}</b>
        <button type="button" className="icon-btn ghost" onClick={togglePin} aria-label={note.pinned ? 'Desafixar' : 'Fixar no topo'} title={note.pinned ? 'Desafixar' : 'Fixar no topo'}>{note.pinned ? <PinOff /> : <Pin />}</button>
        <button type="button" className="icon-btn ghost" onClick={() => setEditing(true)} aria-label="Editar" title="Editar"><Pencil /></button>
        <button type="button" className="icon-btn ghost" onClick={remove} aria-label="Apagar anotação" title="Apagar"><Trash2 /></button>
      </div>
      <div className="note-body">{note.body}</div>
      <div className="small muted">{note.author?.full_name ?? '—'} · {formatDateTime(note.updated_at)}</div>
    </div>
  );
}

function Notes() {
  const [adding, setAdding] = useState(false);
  const { data: notes = [], reload } = useLoad(
    () => must(supabase.from('admin_notes').select('*, author:staff(full_name)').order('pinned', { ascending: false }).order('updated_at', { ascending: false })),
    [],
  );
  return (
    <div className="stack">
      <div className="row">
        <div className="section-title grow" style={{ margin: 0 }}><NotebookPen size={13} /> Anotações</div>
        <button type="button" className="btn btn-sm" onClick={() => setAdding(true)}><Plus /> Nova anotação</button>
      </div>
      {adding && <NoteCard note={{}} onChanged={() => { setAdding(false); reload(); }} />}
      {notes.length === 0 && !adding && <Empty icon={NotebookPen}>Registros livres da recepção ficam aqui.</Empty>}
      <div className="notes-grid">
        {notes.map((n) => <NoteCard key={n.id} note={n} onChanged={reload} />)}
      </div>
    </div>
  );
}

// "Administrativo": the reception's to-do list with reminders and free notes.
export function AdminPage() {
  return (
    <div className="page">
      <header className="topbar">
        <div>
          <h1>Administrativo</h1>
          <div className="sub">Tarefas com lembrete e anotações da recepção</div>
        </div>
      </header>
      <div className="scroll grow admin-layout">
        <Tasks />
        <Notes />
      </div>
    </div>
  );
}
