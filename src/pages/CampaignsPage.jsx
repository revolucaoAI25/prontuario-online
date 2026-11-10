import { useEffect, useMemo, useState } from 'react';
import { Ban, Megaphone, Pause, Pencil, Play, Plus, Search, Trash2, Users, X } from 'lucide-react';
import { supabase, must } from '../lib/supabase.js';
import { useInterval, useLoad } from '../lib/hooks.js';
import { useToast } from '../context/ToastContext.jsx';
import { formatDay, formatDateTime } from '../lib/time.js';
import { Empty, Field, Modal } from '../components/ui.jsx';
import { PatientPicker } from '../components/PatientPicker.jsx';

const WEEKDAYS = [[1, 'Seg'], [2, 'Ter'], [3, 'Qua'], [4, 'Qui'], [5, 'Sex'], [6, 'Sáb'], [0, 'Dom']];
const STATUS = {
  rascunho: ['Rascunho', ''],
  enviando: ['Enviando', 'ok'],
  pausada: ['Pausada', 'warn'],
  concluida: ['Concluída', 'info'],
  cancelada: ['Cancelada', ''],
};
const PAGE = 50;
const ERRORS = {
  campanha_sem_destinatarios: 'A campanha não tem ninguém para receber.',
  campanha_nao_editavel: 'Só dá para mudar o público de um rascunho.',
};
const errorText = (error) => ERRORS[String(error?.message ?? '').match(/\w+$/)?.[0]] ?? error;

// About how long the campaign takes, at its pace and allowed hours.
function estimate(total, c) {
  if (!total) return '';
  const avgGap = (Number(c.gap_min_seconds) + Number(c.gap_max_seconds)) / 2;
  const perWindow = Math.max(1, Math.min(Number(c.batch_size), avgGap > 0 ? Math.floor((Number(c.window_minutes) * 60) / avgGap) + 1 : Number(c.batch_size)));
  const perHour = (perWindow * 60) / Number(c.window_minutes);
  const [h1, m1] = c.hour_start.split(':').map(Number);
  const [h2, m2] = c.hour_end.split(':').map(Number);
  const hoursPerDay = Math.max(0.1, (h2 * 60 + m2 - h1 * 60 - m1) / 60);
  const hours = total / perHour;
  const days = Math.ceil(hours / hoursPerDay);
  const pace = `cerca de ${Math.round(perHour)} por hora`;
  if (hours < hoursPerDay) return `${pace}; termina em cerca de ${hours < 1 ? `${Math.max(1, Math.round(hours * 60))} min` : `${Math.round(hours * 10) / 10} h`} de envio`;
  return `${pace}; cerca de ${days} ${days === 1 ? 'dia' : 'dias'} de envio (${Math.round(hoursPerDay)} h por dia, nos dias marcados)`;
}

function CadenceFields({ form, set }) {
  const toggleDay = (d) => set('weekdays')(form.weekdays.includes(d) ? form.weekdays.filter((x) => x !== d) : [...form.weekdays, d]);
  const num = (k) => (e) => set(k)(e.target.value === '' ? '' : Number(e.target.value));
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="cadence-line">
        Enviar <input className="input" type="number" min="1" max="1000" value={form.batch_size} onChange={num('batch_size')} aria-label="Mensagens por janela" />
        mensagens a cada <input className="input" type="number" min="1" max="1440" value={form.window_minutes} onChange={num('window_minutes')} aria-label="Minutos da janela" /> minutos
      </div>
      <div className="cadence-line">
        Entre uma mensagem e outra: de <input className="input" type="number" min="0" max="3600" value={form.gap_min_seconds} onChange={num('gap_min_seconds')} aria-label="Intervalo mínimo" />
        a <input className="input" type="number" min="0" max="3600" value={form.gap_max_seconds} onChange={num('gap_max_seconds')} aria-label="Intervalo máximo" /> segundos (sorteado)
      </div>
      <div className="cadence-line">
        Só entre <input className="input" type="time" value={form.hour_start} onChange={(e) => set('hour_start')(e.target.value)} aria-label="Início" />
        e <input className="input" type="time" value={form.hour_end} onChange={(e) => set('hour_end')(e.target.value)} aria-label="Fim" />
      </div>
      <div className="row-wrap">
        {WEEKDAYS.map(([d, label]) => (
          <button key={d} type="button" className={`chip ${form.weekdays.includes(d) ? 'on' : ''}`} onClick={() => toggleDay(d)} aria-pressed={form.weekdays.includes(d)}>{label}</button>
        ))}
      </div>
    </div>
  );
}

function AudienceFields({ audience, setAudience, agendas, procedures, cadence }) {
  const { filtros, excluir, incluir, so_selecionados: only } = audience;
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(null);
  const [picked, setPicked] = useState([]);
  const setFilter = (k, v) => { setPage(0); setAudience({ ...audience, filtros: { ...filtros, [k]: v === '' || v == null ? undefined : v } }); };
  const listToggle = (key, id) => setAudience({ ...audience, [key]: audience[key].includes(id) ? audience[key].filter((x) => x !== id) : [...audience[key], id] });
  const filterKey = JSON.stringify(filtros);

  useEffect(() => {
    if (only) return undefined;
    let alive = true;
    const t = setTimeout(async () => {
      const { data, error } = await supabase.rpc('campaign_audience', { p_filters: filtros, p_limit: PAGE, p_offset: page * PAGE });
      if (!alive || error) return;
      setRows(data ?? []);
      setTotal(data?.[0]?.total ?? 0);
    }, 350);
    return () => { alive = false; clearTimeout(t); };
  }, [filterKey, page, only]); // eslint-disable-line react-hooks/exhaustive-deps

  // Names of the patients added by hand (and of the chosen list).
  useEffect(() => {
    const missing = incluir.filter((id) => !picked.some((p) => p.id === id));
    if (missing.length === 0) return;
    supabase.from('patients').select('id, full_name, phone, allow_messages').in('id', missing).then(({ data }) => setPicked((cur) => [...cur, ...(data ?? [])]));
  }, [incluir.join()]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = (p) => {
    if (!p || p.isNew || incluir.includes(p.id)) return;
    setPicked((cur) => [...cur, p]);
    setAudience({ ...audience, incluir: [...incluir, p.id] });
  };
  const chosen = incluir.map((id) => picked.find((p) => p.id === id)).filter(Boolean);
  const lastVisit = filtros.veio_nos_ultimos_meses != null ? 'veio' : filtros.sem_vir_ha_meses != null ? 'sumiu' : '';
  const months = filtros.veio_nos_ultimos_meses ?? filtros.sem_vir_ha_meses ?? 12;

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="seg" role="tablist">
        <button type="button" role="tab" aria-selected={!only} className={!only ? 'active' : ''} onClick={() => setAudience({ ...audience, so_selecionados: false })}>Filtrar a base</button>
        <button type="button" role="tab" aria-selected={only} className={only ? 'active' : ''} onClick={() => setAudience({ ...audience, so_selecionados: true })}>Escolher pacientes</button>
      </div>
      <div className="small muted">Quem pediu para não receber mensagens ou não tem telefone nunca entra.</div>

      {!only && (
        <>
          <div className="form-grid">
            <Field label="Atendido na agenda" full>
              <div className="row-wrap">
                {agendas.map((a) => {
                  const on = (filtros.agendas ?? []).includes(a.id);
                  return <button key={a.id} type="button" className={`chip ${on ? 'on' : ''}`} onClick={() => setFilter('agendas', on ? filtros.agendas.filter((x) => x !== a.id) : [...(filtros.agendas ?? []), a.id])}>{a.name}</button>;
                })}
              </div>
            </Field>
            <Field label="Fez o procedimento">
              <select className="select" value="" onChange={(e) => e.target.value && setFilter('procedimentos', [...new Set([...(filtros.procedimentos ?? []), e.target.value])])}>
                <option value="">Qualquer (escolha para filtrar)</option>
                {procedures.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              {(filtros.procedimentos ?? []).length > 0 && (
                <div className="row-wrap" style={{ marginTop: 6 }}>
                  {filtros.procedimentos.map((id) => (
                    <button key={id} type="button" className="chip on" onClick={() => setFilter('procedimentos', filtros.procedimentos.filter((x) => x !== id))}>
                      {procedures.find((p) => p.id === id)?.name ?? '?'} <X size={12} />
                    </button>
                  ))}
                </div>
              )}
            </Field>
            <Field label="Última visita">
              <div className="row" style={{ gap: 6 }}>
                <select className="select" value={lastVisit} onChange={(e) => {
                  const f = { ...filtros, veio_nos_ultimos_meses: undefined, sem_vir_ha_meses: undefined };
                  if (e.target.value === 'veio') f.veio_nos_ultimos_meses = months;
                  if (e.target.value === 'sumiu') f.sem_vir_ha_meses = months;
                  setPage(0); setAudience({ ...audience, filtros: f });
                }}>
                  <option value="">Qualquer</option>
                  <option value="veio">Veio nos últimos</option>
                  <option value="sumiu">Não vem há mais de</option>
                </select>
                {lastVisit && <><input className="input" style={{ width: 70 }} type="number" min="1" max="240" value={months} onChange={(e) => setFilter(lastVisit === 'veio' ? 'veio_nos_ultimos_meses' : 'sem_vir_ha_meses', Number(e.target.value) || 1)} /> <span className="small">meses</span></>}
              </div>
            </Field>
            <Field label="Aniversário no mês">
              <select className="select" value={filtros.aniversario_mes ?? ''} onChange={(e) => setFilter('aniversario_mes', e.target.value ? Number(e.target.value) : undefined)}>
                <option value="">Qualquer</option>
                {['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'].map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
              </select>
            </Field>
            <Field label="Idade">
              <div className="row" style={{ gap: 6 }}>
                <input className="input" type="number" min="0" max="120" placeholder="de" value={filtros.idade_min ?? ''} onChange={(e) => setFilter('idade_min', e.target.value ? Number(e.target.value) : undefined)} />
                <input className="input" type="number" min="0" max="120" placeholder="até" value={filtros.idade_max ?? ''} onChange={(e) => setFilter('idade_max', e.target.value ? Number(e.target.value) : undefined)} />
              </div>
            </Field>
            <label className="check full"><input type="checkbox" checked={Boolean(filtros.sem_agendamento_futuro)} onChange={(e) => setFilter('sem_agendamento_futuro', e.target.checked || undefined)} /> Só quem não tem nada marcado</label>
          </div>

          <div className="audience-box">
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <b className="grow">{total == null ? 'Contando…' : `${Math.max(0, total - excluir.length) + incluir.length} pacientes`}</b>
              <span className="small muted">{total ?? 0} no filtro{excluir.length ? ` · ${excluir.length} tirados` : ''}{incluir.length ? ` · ${incluir.length} incluídos à mão` : ''}</span>
              <div className="search" style={{ minWidth: 200 }}><Search /><input value={filtros.busca ?? ''} onChange={(e) => setFilter('busca', e.target.value)} placeholder="Procurar na lista" /></div>
            </div>
            {total != null && <div className="small muted" style={{ marginTop: 4 }}>{estimate(Math.max(0, total - excluir.length) + incluir.length, cadence)}</div>}
            <div className="audience-list">
              {rows.map((r) => {
                const out = excluir.includes(r.patient_id);
                return (
                  <div key={r.patient_id} className={`audience-row ${out ? 'out' : ''}`}>
                    <span className="grow">{r.full_name}</span>
                    <span className="small muted">{r.phone}</span>
                    <span className="small muted hide-phone">{r.last_visit ? `última visita ${formatDay(r.last_visit)}` : 'sem visita'}</span>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => listToggle('excluir', r.patient_id)}>{out ? 'Voltar' : 'Tirar'}</button>
                  </div>
                );
              })}
              {total === 0 && <div className="small muted" style={{ padding: 10 }}>Ninguém com esses filtros.</div>}
            </div>
            {total > PAGE && (
              <div className="row" style={{ justifyContent: 'center', gap: 8, marginTop: 6 }}>
                <button type="button" className="btn btn-sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Anterior</button>
                <span className="small muted">{page * PAGE + 1}–{Math.min(total, (page + 1) * PAGE)} de {total}</span>
                <button type="button" className="btn btn-sm" disabled={(page + 1) * PAGE >= total} onClick={() => setPage(page + 1)}>Próximos</button>
              </div>
            )}
          </div>
        </>
      )}

      <Field label={only ? 'Pacientes escolhidos' : 'Incluir também (fora do filtro)'}>
        <PatientPicker value={null} onChange={add} />
      </Field>
      {only && chosen.length > 0 && <div className="small muted">{chosen.length} pacientes · {estimate(chosen.length, cadence)}</div>}
      {chosen.length > 0 && (
        <div className="row-wrap">
          {chosen.map((p) => (
            <button key={p.id} type="button" className={`chip on ${p.allow_messages === false || !p.phone ? 'muted' : ''}`} onClick={() => listToggle('incluir', p.id)}
              title={p.allow_messages === false ? 'Não aceita mensagens: não vai receber' : !p.phone ? 'Sem telefone: não vai receber' : 'Tirar'}>
              {p.full_name} <X size={12} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const DEFAULTS = {
  name: '', webhook_url: '', message: '', batch_size: 20, window_minutes: 60, gap_min_seconds: 30, gap_max_seconds: 60,
  hour_start: '08:00', hour_end: '20:00', weekdays: [1, 2, 3, 4, 5, 6],
};

function CampaignEditor({ campaign, agendas, procedures, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState(() => ({
    ...DEFAULTS,
    ...(campaign ?? {}),
    message: campaign?.message ?? '',
    hour_start: (campaign?.hour_start ?? DEFAULTS.hour_start).slice(0, 5),
    hour_end: (campaign?.hour_end ?? DEFAULTS.hour_end).slice(0, 5),
  }));
  const [audience, setAudience] = useState(() => ({
    filtros: campaign?.audience?.filtros ?? {},
    excluir: campaign?.audience?.excluir ?? [],
    incluir: campaign?.audience?.incluir ?? [],
    so_selecionados: Boolean(campaign?.audience?.so_selecionados),
  }));
  const [saving, setSaving] = useState(false);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  async function save(andStart) {
    if (!form.name.trim()) return toast.error('Dê um nome para a campanha.');
    if (!/^https:\/\//.test(form.webhook_url.trim())) return toast.error('O webhook precisa começar com https://');
    if (!(form.batch_size >= 1) || !(form.window_minutes >= 1)) return toast.error('Confira a cadência: mensagens e minutos.');
    if (form.gap_max_seconds < form.gap_min_seconds) return toast.error('O intervalo máximo precisa ser maior que o mínimo.');
    if (form.hour_end <= form.hour_start) return toast.error('O horário final precisa ser depois do inicial.');
    if (form.weekdays.length === 0) return toast.error('Escolha pelo menos um dia da semana.');
    if (audience.so_selecionados && audience.incluir.length === 0) return toast.error('Escolha os pacientes.');
    setSaving(true);
    try {
      const row = {
        name: form.name.trim(), webhook_url: form.webhook_url.trim(), message: form.message.trim() || null,
        batch_size: form.batch_size, window_minutes: form.window_minutes, gap_min_seconds: form.gap_min_seconds, gap_max_seconds: form.gap_max_seconds,
        hour_start: form.hour_start, hour_end: form.hour_end, weekdays: form.weekdays,
      };
      const saved = campaign?.id
        ? await must(supabase.from('campaigns').update(row).eq('id', campaign.id).select().single())
        : await must(supabase.from('campaigns').insert(row).select().single());
      if (saved.status === 'rascunho') {
        const filters = Object.fromEntries(Object.entries(audience.filtros).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0)));
        const n = await must(supabase.rpc('set_campaign_recipients', {
          p_campaign_id: saved.id, p_filters: filters, p_exclude: audience.excluir, p_include: audience.incluir, p_only_included: audience.so_selecionados,
        }));
        if (andStart) {
          // The database job calls back this address to send.
          if (/^https:\/\//.test(window.location.origin)) await supabase.from('settings').update({ value: window.location.origin }).eq('key', 'app_url');
          await must(supabase.rpc('set_campaign_status', { p_campaign_id: saved.id, p_status: 'enviando' }));
          toast.info(`Campanha iniciada para ${n} pacientes.`);
        } else {
          toast.info(`Rascunho salvo (${n} pacientes).`);
        }
      } else {
        toast.info('Campanha atualizada. O público não muda depois de iniciada.');
      }
      onSaved();
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setSaving(false);
    }
    return null;
  }

  const draft = !campaign || campaign.status === 'rascunho';
  return (
    <Modal title={campaign ? 'Editar campanha' : 'Nova campanha'} wide onClose={onClose}
      footer={<>
        <button type="button" className="btn" onClick={onClose}>Cancelar</button>
        <button type="button" className="btn" disabled={saving} onClick={() => save(false)}>{draft ? 'Salvar rascunho' : 'Salvar'}</button>
        {draft && <button type="button" className="btn btn-primary" disabled={saving} onClick={() => save(true)}><Play /> Salvar e iniciar</button>}
      </>}>
      <div className="stack" style={{ gap: 18 }}>
        <section className="stack" style={{ gap: 10 }}>
          <div className="section-title">Campanha</div>
          <div className="form-grid">
            <Field label="Nome"><input className="input" autoFocus value={form.name} onChange={(e) => set('name')(e.target.value)} placeholder="ex.: Black Friday Botox" /></Field>
            <Field label="Webhook desta campanha"><input className="input" value={form.webhook_url} onChange={(e) => set('webhook_url')(e.target.value)} placeholder="https://..." /></Field>
            <Field label="Mensagem ou instrução (vai no JSON, opcional)" full>
              <textarea className="textarea" rows={3} value={form.message} onChange={(e) => set('message')(e.target.value)} placeholder="ex.: Oferta de Botox com 20% até 30/11. Convidar para avaliação." />
            </Field>
          </div>
        </section>
        <section className="stack" style={{ gap: 10 }}>
          <div className="section-title">Quem recebe</div>
          {draft
            ? <AudienceFields audience={audience} setAudience={setAudience} agendas={agendas} procedures={procedures} cadence={form} />
            : <div className="small muted">O público foi definido ao iniciar. Para tirar alguém, use "Ver envios".</div>}
        </section>
        <section className="stack" style={{ gap: 10 }}>
          <div className="section-title">Cadência</div>
          <CadenceFields form={form} set={set} />
        </section>
      </div>
    </Modal>
  );
}

function RecipientsModal({ campaign, onClose, onChanged }) {
  const toast = useToast();
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const { data: rows = [], reload } = useLoad(() => {
    let q = supabase.from('campaign_recipients').select('id, status, attempts, sent_at, last_error, patient:patients!inner(id, full_name, phone)')
      .eq('campaign_id', campaign.id).order('created_at').limit(300);
    if (status) q = q.eq('status', status);
    if (search.trim()) q = q.ilike('patient.full_name', `%${search.trim()}%`);
    return must(q);
  }, [status, search]);

  async function remove(r) {
    const { error } = await supabase.from('campaign_recipients').update({ status: 'removido' }).eq('id', r.id).eq('status', 'pendente');
    if (error) return toast.error(error);
    reload();
    return onChanged();
  }

  return (
    <Modal title={`Envios · ${campaign.name}`} wide onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Fechar</button>}>
      <div className="row" style={{ gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <select className="select" style={{ width: 160 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Todos</option><option value="pendente">Na fila</option><option value="enviado">Enviados</option><option value="erro">Com erro</option><option value="removido">Tirados</option>
        </select>
        <div className="search grow"><Search /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Procurar paciente" /></div>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Paciente</th><th>Telefone</th><th>Situação</th><th>Enviado em</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.patient?.full_name}</td>
                <td className="small">{r.patient?.phone}</td>
                <td>
                  <span className={`tag ${r.status === 'enviado' ? 'ok' : r.status === 'erro' ? 'danger' : r.status === 'removido' ? '' : 'warn'}`}>
                    {{ pendente: 'Na fila', enviado: 'Enviado', erro: 'Erro', removido: 'Tirado' }[r.status]}
                  </span>
                  {r.last_error && r.status !== 'enviado' && <div className="small muted" title={r.last_error}>{r.attempts}ª tentativa: {r.last_error.slice(0, 60)}</div>}
                </td>
                <td className="small">{r.sent_at ? formatDateTime(r.sent_at) : '—'}</td>
                <td>{r.status === 'pendente' && <button type="button" className="btn btn-sm btn-ghost" onClick={() => remove(r)}>Tirar</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <Empty icon={Users}>Ninguém aqui.</Empty>}
      </div>
      {rows.length === 300 && <div className="small muted" style={{ marginTop: 6 }}>Mostrando os 300 primeiros. Use a busca para achar alguém.</div>}
    </Modal>
  );
}

function CampaignCard({ c, onEdit, onRecipients, onChanged }) {
  const toast = useToast();
  const [label, tone] = STATUS[c.status];
  const total = Number(c.total);
  const done = Number(c.enviados) + Number(c.erros);
  const pct = total ? Math.round((done / total) * 100) : 0;

  async function setStatus(next) {
    if (next === 'cancelada') {
      // eslint-disable-next-line no-alert
      if (!window.confirm(`Cancelar "${c.name}"? Quem ainda não recebeu não recebe mais.`)) return null;
    }
    if (next === 'enviando' && /^https:\/\//.test(window.location.origin)) {
      await supabase.from('settings').update({ value: window.location.origin }).eq('key', 'app_url');
    }
    const { error } = await supabase.rpc('set_campaign_status', { p_campaign_id: c.id, p_status: next });
    if (error) return toast.error(errorText(error));
    return onChanged();
  }

  async function remove() {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Apagar "${c.name}" e o histórico de envios dela?`)) return null;
    const { error } = await supabase.from('campaigns').delete().eq('id', c.id);
    if (error) return toast.error(error);
    return onChanged();
  }

  return (
    <div className="card card-pad campaign-card">
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <b className="grow" style={{ fontSize: 15 }}>{c.name}</b>
        <span className={`tag ${tone}`}>{label}</span>
      </div>
      {c.message && <div className="small muted" style={{ marginTop: 4 }}>{c.message}</div>}
      <div className="meter" style={{ margin: '12px 0 6px' }}><div style={{ width: `${pct}%` }} /></div>
      <div className="row small" style={{ gap: 12, flexWrap: 'wrap' }}>
        <span><b>{c.enviados}</b> enviados</span>
        <span><b>{c.pendentes}</b> na fila</span>
        {Number(c.erros) > 0 && <span style={{ color: 'var(--danger)' }}><b>{c.erros}</b> com erro</span>}
        <span className="muted">de {total}</span>
      </div>
      <div className="small muted" style={{ marginTop: 6 }}>
        {c.batch_size} a cada {c.window_minutes} min · {c.gap_min_seconds}–{c.gap_max_seconds} s entre elas · {c.hour_start.slice(0, 5)}–{c.hour_end.slice(0, 5)}
        {' · '}{WEEKDAYS.filter(([d]) => c.weekdays.includes(d)).map(([, l]) => l).join(', ')}
      </div>
      {['rascunho', 'enviando', 'pausada'].includes(c.status) && Number(c.pendentes) > 0 && <div className="small muted">Falta: {estimate(Number(c.pendentes), c)}</div>}
      {c.status === 'enviando' && c.next_send_at && <div className="small" style={{ marginTop: 4 }}>Próximo envio: {formatDateTime(c.next_send_at)}</div>}
      {c.status === 'concluida' && c.finished_at && <div className="small" style={{ marginTop: 4 }}>Concluída em {formatDateTime(c.finished_at)}</div>}
      <div className="small muted" style={{ marginTop: 4, overflowWrap: 'anywhere' }}>Webhook: {c.webhook_url}</div>
      <div className="row-wrap" style={{ marginTop: 12 }}>
        {(c.status === 'rascunho' || c.status === 'pausada') && <button type="button" className="btn btn-sm btn-primary" onClick={() => setStatus('enviando')}><Play /> {c.status === 'rascunho' ? 'Iniciar' : 'Retomar'}</button>}
        {c.status === 'enviando' && <button type="button" className="btn btn-sm" onClick={() => setStatus('pausada')}><Pause /> Pausar</button>}
        {c.status !== 'concluida' && c.status !== 'cancelada' && <button type="button" className="btn btn-sm" onClick={onEdit}><Pencil /> Editar</button>}
        <button type="button" className="btn btn-sm" onClick={onRecipients}><Users /> Ver envios</button>
        {['rascunho', 'enviando', 'pausada'].includes(c.status) && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setStatus('cancelada')}><Ban /> Cancelar</button>}
        {['rascunho', 'concluida', 'cancelada'].includes(c.status) && <button type="button" className="btn btn-sm btn-ghost" style={{ color: 'var(--danger)' }} onClick={remove}><Trash2 /> Apagar</button>}
      </div>
    </div>
  );
}

// Campaigns ("Disparos"): the super admin's mass sends, each to its own
// webhook, at a set pace. See docs/WEBHOOKS.md for the JSON.
export function CampaignsPage() {
  const { data: campaigns = [], reload } = useLoad(() => must(supabase.from('campaign_progress').select('*').order('created_at', { ascending: false })), []);
  const { data: agendas = [] } = useLoad(() => must(supabase.from('agendas').select('id, name').eq('active', true).order('sort_order')), []);
  const { data: procedures = [] } = useLoad(() => must(supabase.from('procedures').select('id, name').eq('active', true).order('name')), []);
  const [editing, setEditing] = useState(null);
  const [viewing, setViewing] = useState(null);
  const sending = useMemo(() => campaigns.some((c) => c.status === 'enviando'), [campaigns]);
  useInterval(() => { if (sending) reload(); }, 10000);

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <h1>Disparos</h1>
          <div className="sub">Campanhas para a base de pacientes, cada uma com o seu webhook · só o super admin vê esta tela</div>
        </div>
        <div className="topbar-right">
          <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}><Plus /> Nova campanha</button>
        </div>
      </header>
      {campaigns.length === 0 && <Empty icon={Megaphone}>Nenhuma campanha ainda.</Empty>}
      <div className="campaign-grid">
        {campaigns.map((c) => (
          <CampaignCard key={c.id} c={c} onEdit={() => setEditing(c)} onRecipients={() => setViewing(c)} onChanged={reload} />
        ))}
      </div>
      {editing && (
        <CampaignEditor campaign={editing === 'new' ? null : editing} agendas={agendas} procedures={procedures}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />
      )}
      {viewing && <RecipientsModal campaign={viewing} onClose={() => setViewing(null)} onChanged={reload} />}
    </div>
  );
}
