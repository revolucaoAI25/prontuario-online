import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, ChevronLeft, ChevronRight, Lock } from 'lucide-react';
import { supabase, must } from '../lib/supabase.js';
import { useLoad } from '../lib/hooks.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { formatMoney, methodLabel } from '../lib/format.js';
import { addDays, formatDay, formatFullDate, formatWeekday, localDay } from '../lib/time.js';
import { Empty } from '../components/ui.jsx';
import { ExpensesTab } from './finance/ExpensesTab.jsx';
import { usePeriod } from './finance/period.jsx';

const summaryFor = (from, to) => must(supabase.rpc('finance_summary', { p_from: from, p_to: to }));
const paymentsFor = (from, to) => must(
  supabase.from('payments').select('*, patient:patients(id, full_name), agenda:agendas(name, color)')
    .gte('occurred_on', from).lte('occurred_on', to)
    .order('occurred_on', { ascending: false }).order('created_at', { ascending: false }),
);

function AgendaDot({ color }) {
  return <i className="dot-sw" style={{ background: color ?? 'var(--border-strong)' }} />;
}

function PaymentsTable({ rows, onMarkPaid, showDay }) {
  return (
    <table className="table">
      <thead><tr>{showDay && <th>Data</th>}<th>Paciente</th><th>Agenda</th><th>Descrição</th><th>Forma</th><th className="num">Valor</th><th>Situação</th></tr></thead>
      <tbody>
        {rows.map((p) => (
          <tr key={p.id}>
            {showDay && <td className="mono">{formatDay(p.occurred_on)}</td>}
            <td><Link to={`/prontuario/${p.patient?.id}`}>{p.patient?.full_name}</Link></td>
            <td style={{ whiteSpace: 'nowrap' }}><span className="row" style={{ gap: 7 }}><AgendaDot color={p.agenda?.color} />{p.agenda?.name ?? 'Balcão'}</span></td>
            <td>{p.description}</td>
            <td>{methodLabel(p.method)}{p.installments > 1 ? ` · ${p.installments}x` : ''}</td>
            <td className="num"><b>{formatMoney(p.amount)}</b></td>
            <td>{p.status === 'pago' ? <span className="tag ok">Pago</span> : (
              <button type="button" className="btn btn-sm" onClick={() => onMarkPaid(p)}><Check /> Marcar pago</button>
            )}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function useMarkPaid(after) {
  const toast = useToast();
  return async (p) => {
    const { error } = await supabase.from('payments').update({ status: 'pago', method: p.method ?? 'pix' }).eq('id', p.id);
    if (error) return toast.error(error);
    after();
  };
}

function ReceptionNote() {
  const { isAdmin } = useAuth();
  if (isAdmin) return null;
  return <div className="banner info row" style={{ marginBottom: 14 }}><Lock size={15} /><span className="grow">Aqui aparecem só as agendas liberadas para a recepção. As demais são vistas apenas pelo administrador.</span></div>;
}

// "How did yesterday go?": each agenda's takings, the day's expenses and what is left.
function DailyClose() {
  const { isAdmin } = useAuth();
  const [day, setDay] = useState(() => addDays(localDay(), -1));
  const { data: summary, reload: reloadSummary } = useLoad(() => summaryFor(day, day), [day]);
  const { data: rows = [], reload } = useLoad(() => paymentsFor(day, day), [day]);
  const { data: expenses = [] } = useLoad(() => must(supabase.from('expenses').select('*').eq('occurred_on', day).order('created_at')), [day]);
  const markPaid = useMarkPaid(() => { reload(); reloadSummary(); });

  const received = Number(summary?.total_pago ?? 0);
  const spent = Number(summary?.despesas_total ?? 0);
  const today = localDay();
  const agendas = (summary?.por_agenda ?? []).filter((a) => a.agenda_id || Number(a.quantidade) > 0);

  return (
    <>
      <div className="row-wrap" style={{ marginBottom: 14 }}>
        <div className="daynav card" style={{ padding: '6px 10px' }}>
          <button type="button" className="icon-btn ghost" onClick={() => setDay(addDays(day, -1))} aria-label="Dia anterior"><ChevronLeft /></button>
          <button type="button" className="icon-btn ghost" onClick={() => setDay(addDays(day, 1))} disabled={day >= today} aria-label="Dia seguinte"><ChevronRight /></button>
          <label className="daylabel" title="Escolher data">
            {formatWeekday(day)}
            <span className="d2">{formatFullDate(day)}</span>
            <input type="date" value={day} max={today} onChange={(e) => e.target.value && setDay(e.target.value)} />
          </label>
        </div>
        <div className="seg">
          <button type="button" className={day === addDays(today, -1) ? 'active' : ''} onClick={() => setDay(addDays(today, -1))}>Ontem</button>
          <button type="button" className={day === today ? 'active' : ''} onClick={() => setDay(today)}>Hoje</button>
        </div>
      </div>
      <ReceptionNote />

      <div className="kpis">
        <div className="card kpi"><div className="lbl">{isAdmin ? 'Recebido' : 'Recebido nas agendas liberadas'}</div><div className="val">{formatMoney(received)}</div></div>
        <div className="card kpi"><div className="lbl">Despesas</div><div className="val" style={{ color: 'var(--danger)' }}>{formatMoney(spent)}</div></div>
        {/* The balance only means something with every agenda in it. */}
        {isAdmin && <div className="card kpi"><div className="lbl">Saldo do dia</div><div className="val" style={{ color: received - spent < 0 ? 'var(--danger)' : 'var(--ok)' }}>{formatMoney(received - spent)}</div></div>}
        <div className="card kpi"><div className="lbl">Ficou a receber</div><div className="val" style={{ color: 'var(--warn)' }}>{formatMoney(summary?.total_pendente)}</div></div>
      </div>

      <div className="close-grid">
        {agendas.map((a) => (
          <div key={a.agenda_id ?? 'balcao'} className="card card-pad close-card">
            <div className="row" style={{ gap: 8 }}><AgendaDot color={a.cor} /><b className="grow">{a.nome}</b></div>
            <div className="close-val">{formatMoney(a.pago)}</div>
            <div className="small muted">
              {a.agenda_id ? `${a.atendimentos} ${a.atendimentos === 1 ? 'atendimento' : 'atendimentos'} · ` : ''}
              {a.quantidade} {Number(a.quantidade) === 1 ? 'lançamento' : 'lançamentos'}
            </div>
            {Number(a.pendente) > 0 && <div className="small" style={{ color: 'var(--warn)', fontWeight: 600 }}>+ {formatMoney(a.pendente)} a receber</div>}
            {a.por_forma.length > 0 && (
              <div className="close-forms">
                {a.por_forma.map((f) => <div key={f.forma} className="row small"><span className="grow muted">{methodLabel(f.forma)}</span><span className="tnum">{formatMoney(f.total)}</span></div>)}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="close-lists">
        <div className="card">
          <div className="section-title" style={{ padding: '14px 14px 0' }}>Lançamentos do dia</div>
          <PaymentsTable rows={rows} onMarkPaid={markPaid} />
          {rows.length === 0 && <Empty>Nenhum lançamento neste dia.</Empty>}
        </div>
        <div className="card card-pad">
          <div className="section-title">Despesas do dia</div>
          {expenses.length === 0 && <div className="small muted">Nenhuma despesa lançada.</div>}
          {expenses.map((e) => (
            <div key={e.id} className="side-item row">
              <div className="grow"><div style={{ fontWeight: 600 }}>{e.description}</div><div className="small muted">{e.category ?? 'Sem categoria'}{e.method ? ` · ${methodLabel(e.method)}` : ''}</div></div>
              <b className="tnum">{formatMoney(e.amount)}</b>
            </div>
          ))}
          {expenses.length > 0 && <div className="row" style={{ marginTop: 10 }}><span className="grow small muted">Total</span><b className="tnum">{formatMoney(spent)}</b></div>}
        </div>
      </div>
    </>
  );
}

// Any period: totals per agenda (the commissions are computed from here) and every entry.
function PeriodReport() {
  const { from, to, picker, label } = usePeriod('mes');
  const [statusFilter, setStatusFilter] = useState('todos');
  const [agendaFilter, setAgendaFilter] = useState('todas');
  const { data: summary, reload: reloadSummary } = useLoad(() => summaryFor(from, to), [from, to]);
  const { data: rows = [], reload } = useLoad(() => paymentsFor(from, to), [from, to]);
  const { data: openPending = [], reload: reloadPending } = useLoad(() => must(supabase.from('payments').select('amount').eq('status', 'pendente')), []);
  const markPaid = useMarkPaid(() => { reload(); reloadSummary(); reloadPending(); });

  const agendas = (summary?.por_agenda ?? []).filter((a) => a.agenda_id || Number(a.quantidade) > 0);
  const shown = rows.filter((r) => (statusFilter === 'todos' || r.status === statusFilter)
    && (agendaFilter === 'todas' || (r.agenda_id ?? 'balcao') === agendaFilter));
  const maxDay = useMemo(() => Math.max(1, ...(summary?.por_dia ?? []).map((d) => Number(d.pago ?? 0) + Number(d.pendente ?? 0))), [summary]);
  const totalPaid = Number(summary?.total_pago ?? 0);
  const maxAgenda = Math.max(1, ...agendas.map((a) => Number(a.pago)));

  return (
    <>
      <div className="row-wrap" style={{ marginBottom: 14 }}>{picker}<span className="small muted">{label}</span></div>
      <ReceptionNote />
      <div className="kpis">
        <div className="card kpi"><div className="lbl">Recebido</div><div className="val">{formatMoney(summary?.total_pago)}</div></div>
        <div className="card kpi"><div className="lbl">Pendente no período</div><div className="val" style={{ color: 'var(--warn)' }}>{formatMoney(summary?.total_pendente)}</div></div>
        <div className="card kpi"><div className="lbl">Despesas</div><div className="val" style={{ color: 'var(--danger)' }}>{formatMoney(summary?.despesas_total)}</div></div>
        <div className="card kpi"><div className="lbl">Pendências em aberto (total)</div><div className="val" style={{ color: 'var(--danger)' }}>{formatMoney(openPending.reduce((s, p) => s + Number(p.amount), 0))}</div></div>
      </div>

      <div className="row" style={{ alignItems: 'stretch', gap: 14, marginBottom: 14, flexWrap: 'wrap' }}>
        <div className="card card-pad" style={{ flex: '1 1 340px' }}>
          <div className="section-title">Por agenda</div>
          {agendas.map((a) => (
            <div key={a.agenda_id ?? 'balcao'} style={{ marginBottom: 10 }}>
              <div className="row small"><AgendaDot color={a.cor} /><b>{a.nome}</b><span className="muted">{a.agenda_id ? `${a.atendimentos} atend.` : ''}</span><span className="grow" /><b className="tnum">{formatMoney(a.pago)}</b></div>
              <div className="meter"><div style={{ width: `${(Number(a.pago) / maxAgenda) * 100}%`, background: a.cor ?? 'var(--brand)' }} /></div>
            </div>
          ))}
        </div>
        <div className="card card-pad" style={{ flex: '1 1 300px' }}>
          <div className="section-title">Por forma de pagamento</div>
          {(summary?.por_forma ?? []).length === 0 && <div className="small muted">Nada recebido no período.</div>}
          {(summary?.por_forma ?? []).map((f) => (
            <div key={f.forma} style={{ marginBottom: 10 }}>
              <div className="row small"><b>{methodLabel(f.forma)}</b><span className="muted">{f.quantidade}x</span><span className="grow" /><b className="tnum">{formatMoney(f.total)}</b></div>
              <div className="meter"><div style={{ width: `${totalPaid ? (Number(f.total) / totalPaid) * 100 : 0}%` }} /></div>
            </div>
          ))}
        </div>
        {(summary?.por_dia ?? []).length > 1 && (
          <div className="card card-pad" style={{ flex: '2 1 420px' }}>
            <div className="section-title">Por dia</div>
            <div className="bars">
              {summary.por_dia.map((d) => (
                <div key={d.dia} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%' }} title={`${formatDay(d.dia)}: ${formatMoney(d.pago)} pago, ${formatMoney(d.pendente)} pendente`}>
                  <div className="bar pend" style={{ height: `${(Number(d.pendente ?? 0) / maxDay) * 100}%` }} />
                  <div className="bar" style={{ height: `${(Number(d.pago ?? 0) / maxDay) * 100}%` }} />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <div className="row-wrap" style={{ padding: '12px 14px' }}>
          <div className="section-title" style={{ margin: 0 }}>Lançamentos</div>
          <span className="grow" />
          <select className="select" style={{ width: 'auto' }} value={agendaFilter} onChange={(e) => setAgendaFilter(e.target.value)} aria-label="Agenda">
            <option value="todas">Todas as agendas</option>
            {agendas.map((a) => <option key={a.agenda_id ?? 'balcao'} value={a.agenda_id ?? 'balcao'}>{a.nome}</option>)}
          </select>
          <div className="seg">
            {[['todos', 'Todos'], ['pago', 'Pagos'], ['pendente', 'Pendentes']].map(([id, text]) => (
              <button key={id} type="button" className={statusFilter === id ? 'active' : ''} onClick={() => setStatusFilter(id)}>{text}</button>
            ))}
          </div>
        </div>
        <PaymentsTable rows={shown} onMarkPaid={markPaid} showDay />
        {shown.length === 0 && <Empty>Nenhum lançamento no período.</Empty>}
      </div>
    </>
  );
}

const TABS = [
  ['fechamento', 'Fechamento do dia', DailyClose],
  ['periodo', 'Relatório do período', PeriodReport],
  ['despesas', 'Despesas', ExpensesTab],
];

// Dr. Everson sees every agenda; the reception sees the agendas shared with
// it (Ajustes → Agendas) and records the expenses. The database enforces it.
export function FinancePage() {
  const [tab, setTab] = useState('fechamento');
  const Current = TABS.find(([id]) => id === tab)[2];
  return (
    <div className="page">
      <header className="topbar"><div><h1>Financeiro</h1><div className="sub">Caixa por agenda, recebimentos e despesas</div></div></header>
      <div className="tabs">
        {TABS.map(([id, text]) => <button key={id} type="button" className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{text}</button>)}
      </div>
      <div className="scroll grow"><Current /></div>
    </div>
  );
}
