import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Merge, UserX } from 'lucide-react';
import { supabase, must } from '../lib/supabase.js';
import { useLoad } from '../lib/hooks.js';
import { useToast } from '../context/ToastContext.jsx';
import { ageFrom, formatDay, localDay } from '../lib/time.js';
import { Empty, Modal } from '../components/ui.jsx';

const PAGE = 12;

// What helps decide which record stays: contacts, visits, record entries.
async function loadDetails(ids) {
  if (ids.length === 0) return {};
  const patients = await must(supabase.from('patients').select('id, full_name, phone, phone_alt, cpf, email, birth_date, legacy_id, created_at').in('id', ids));
  const extra = await Promise.all(ids.map(async (id) => {
    const [visits, entries, last] = await Promise.all([
      supabase.from('appointments').select('id', { count: 'exact', head: true }).eq('patient_id', id).eq('status', 'chegou'),
      supabase.from('record_entries').select('id', { count: 'exact', head: true }).eq('patient_id', id),
      supabase.from('appointments').select('starts_at').eq('patient_id', id).eq('status', 'chegou').order('starts_at', { ascending: false }).limit(1),
    ]);
    return [id, { visits: visits.count ?? 0, entries: entries.count ?? 0, last: last.data?.[0]?.starts_at ?? null }];
  }));
  const byId = Object.fromEntries(extra);
  return Object.fromEntries(patients.map((p) => [p.id, { ...p, ...byId[p.id] }]));
}

function Side({ p, onKeep, busy }) {
  if (!p) return <div className="dup-side muted small">Carregando…</div>;
  const age = ageFrom(p.birth_date);
  return (
    <div className="dup-side">
      <Link to={`/prontuario/${p.id}`} target="_blank" className="dup-name">{p.full_name}</Link>
      <div className="small">{[p.phone, p.phone_alt].filter(Boolean).join(' · ') || <span className="muted">sem telefone</span>}</div>
      <div className="small muted">{[p.cpf && `CPF ${p.cpf}`, p.email, p.birth_date && `${formatDay(p.birth_date)}${age != null ? ` (${age} anos)` : ''}`].filter(Boolean).join(' · ') || '—'}</div>
      <div className="small"><b>{p.visits}</b> atendimentos · <b>{p.entries}</b> registros no prontuário{p.last ? ` · último em ${formatDay(localDay(p.last))}` : ''}</div>
      <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={onKeep}><Merge /> Manter este e juntar o outro nele</button>
    </div>
  );
}

// Likely duplicate patients (same CPF, same phone and first name, or the same
// full name), side by side. Merging moves visits, record, payments, reminders
// and WhatsApp to the one that stays. Admin only.
export function DuplicatesModal({ onClose }) {
  const toast = useToast();
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const { data: pairs = [], reload } = useLoad(() => must(supabase.rpc('duplicate_patient_pairs', { p_limit: 500 })), []);
  const shown = pairs.slice(page * PAGE, (page + 1) * PAGE);
  const ids = [...new Set(shown.flatMap((x) => [x.patient_a, x.patient_b]))];
  const { data: details = {} } = useLoad(() => loadDetails(ids), [ids.join()]);

  async function merge(keep, drop) {
    const k = details[keep];
    const d = details[drop];
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Juntar "${d?.full_name}" em "${k?.full_name}"?\n\nAtendimentos, prontuário, financeiro, lembretes e WhatsApp passam para o cadastro que fica. O outro cadastro é apagado. Não dá para desfazer.`)) return;
    setBusy(true);
    const { error } = await supabase.rpc('merge_patients', { p_keep: keep, p_drop: drop });
    setBusy(false);
    if (error) return toast.error(error);
    toast.info('Cadastros juntados.');
    return reload();
  }

  async function different(pair) {
    const { error } = await supabase.from('patient_not_duplicates').insert({ patient_a: pair.patient_a, patient_b: pair.patient_b });
    if (error) return toast.error(error);
    return reload();
  }

  return (
    <Modal title="Pacientes duplicados" wide onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Fechar</button>}>
      <div className="small muted" style={{ marginBottom: 12 }}>
        Possíveis cadastros repetidos: mesmo CPF, mesmo telefone com o mesmo primeiro nome, ou o mesmo nome completo.
        Escolha qual cadastro fica; tudo do outro vem para ele.
      </div>
      {pairs.length === 0 && <Empty icon={UserX}>Nenhum possível duplicado encontrado.</Empty>}
      {shown.map((pair) => (
        <div key={`${pair.patient_a}-${pair.patient_b}`} className="dup-pair">
          <div className="row"><span className="tag warn">{pair.motivo}</span><span className="grow" />
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => different(pair)}>Não são a mesma pessoa</button>
          </div>
          <div className="dup-sides">
            <Side p={details[pair.patient_a]} busy={busy} onKeep={() => merge(pair.patient_a, pair.patient_b)} />
            <Side p={details[pair.patient_b]} busy={busy} onKeep={() => merge(pair.patient_b, pair.patient_a)} />
          </div>
        </div>
      ))}
      {pairs.length > PAGE && (
        <div className="row" style={{ justifyContent: 'center', marginTop: 10 }}>
          <button type="button" className="btn btn-sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Anterior</button>
          <span className="small muted">{page * PAGE + 1}–{Math.min(pairs.length, (page + 1) * PAGE)} de {pairs.length}{pairs.length >= 500 ? '+' : ''}</span>
          <button type="button" className="btn btn-sm" disabled={(page + 1) * PAGE >= pairs.length} onClick={() => setPage(page + 1)}>Próximos</button>
        </div>
      )}
    </Modal>
  );
}
