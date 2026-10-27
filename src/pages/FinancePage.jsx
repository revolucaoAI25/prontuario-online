import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check } from 'lucide-react';
import { supabase, must } from '../lib/supabase.js';
import { useLoad } from '../lib/hooks.js';
import { useToast } from '../context/ToastContext.jsx';
import { formatMoney, methodLabel } from '../lib/format.js';
import { addDays, formatDay, localDay } from '../lib/time.js';
import { Empty } from '../components/ui.jsx';

function monthRange(offset) {
  const [y, m] = localDay().split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + offset, 1));
  const last = new Date(Date.UTC(y, m + offset, 0));
  return [first.toISOString().slice(0, 10), last.toISOString().slice(0, 10)];
}

const PRESETS = {
  hoje: () => [localDay(), localDay()],
  ontem: () => [addDays(localDay(), -1), addDays(localDay(), -1)],
  mes: () => monthRange(0),
  mes_passado: () => monthRange(-1),
};

// Daily/monthly totals: who paid, how much and how. Dr. Everson only.
export function FinancePage() {
  const toast = useToast();
  const [preset, setPreset] = useState('hoje');
  const [custom, setCustom] = useState(() => monthRange(0));
  const [statusFilter, setStatusFilter] = useState('todos');
  const [from, to] = preset === 'custom' ? custom : PRESETS[preset]();

  const { data: summary } = useLoad(() => must(supabase.rpc('finance_summary', { p_from: from, p_to: to })), [from, to]);
  const { data: rows = [], reload } = useLoad(
    () => must(supabase.from('payments').select('*, patient:patients(id, full_name)').gte('occurred_on', from).lte('occurred_on', to).order('occurred_on', { ascending: false }).order('created_at', { ascending: false })),
    [from, to],
  );
  const { data: openPending = [], reload: reloadPending } = useLoad(
    () => must(supabase.from('payments').select('amount').eq('status', 'pendente')),
    [],
  );

  const shown = rows.filter((r) => statusFilter === 'todos' || r.status === statusFilter);
  const maxDay = useMemo(() => Math.max(1, ...(summary?.por_dia ?? []).map((d) => Number(d.pago ?? 0) + Number(d.pendente ?? 0))), [summary]);
  const totalPaid = Number(summary?.total_pago ?? 0);

  async function markPaid(p) {
    const { error } = await supabase.from('payments').update({ status: 'pago', method: p.method ?? 'pix' }).eq('id', p.id);
    if (error) return toast.error(error);
    reload();
    reloadPending();
  }

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <h1>Financeiro</h1>
          <div className="sub">{from === to ? formatDay(from) : `${formatDay(from)} a ${formatDay(to)}`}</div>
        </div>
        <div className="topbar-right">
          <div className="seg">
            {[['hoje', 'Hoje'], ['ontem', 'Ontem'], ['mes', 'Este mês'], ['mes_passado', 'Mês passado'], ['custom', 'Período']].map(([id, label]) => (
              <button key={id} type="button" className={preset === id ? 'active' : ''} onClick={() => setPreset(id)}>{label}</button>
            ))}
          </div>
          {preset === 'custom' && (
            <div className="row">
              <input className="input" type="date" value={custom[0]} onChange={(e) => setCustom([e.target.value, custom[1]])} />
              <input className="input" type="date" value={custom[1]} onChange={(e) => setCustom([custom[0], e.target.value])} />
            </div>
          )}
        </div>
      </header>

      <div className="scroll grow">
        <div className="kpis">
          <div className="card kpi"><div className="lbl">Recebido</div><div className="val">{formatMoney(summary?.total_pago)}</div></div>
          <div className="card kpi"><div className="lbl">Pendente no período</div><div className="val" style={{ color: 'var(--warn)' }}>{formatMoney(summary?.total_pendente)}</div></div>
          <div className="card kpi"><div className="lbl">Lançamentos</div><div className="val">{summary?.quantidade ?? 0}</div></div>
          <div className="card kpi"><div className="lbl">Pendências em aberto (total)</div><div className="val" style={{ color: 'var(--danger)' }}>{formatMoney(openPending.reduce((s, p) => s + Number(p.amount), 0))}</div></div>
        </div>

        <div className="row" style={{ alignItems: 'stretch', gap: 14, marginBottom: 14, flexWrap: 'wrap' }}>
          <div className="card card-pad" style={{ flex: '1 1 320px' }}>
            <div className="section-title">Por forma de pagamento</div>
            {(summary?.por_forma ?? []).length === 0 && <div className="small muted">Nada recebido no período.</div>}
            {(summary?.por_forma ?? []).map((f) => (
              <div key={f.forma} style={{ marginBottom: 10 }}>
                <div className="row small"><b>{methodLabel(f.forma)}</b><span className="muted">{f.quantidade}x</span><span className="grow" /><b>{formatMoney(f.total)}</b></div>
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
          <div className="row" style={{ padding: '12px 14px' }}>
            <div className="section-title" style={{ margin: 0 }}>Lançamentos</div>
            <span className="grow" />
            <div className="seg">
              {[['todos', 'Todos'], ['pago', 'Pagos'], ['pendente', 'Pendentes']].map(([id, label]) => (
                <button key={id} type="button" className={statusFilter === id ? 'active' : ''} onClick={() => setStatusFilter(id)}>{label}</button>
              ))}
            </div>
          </div>
          <table className="table">
            <thead><tr><th>Data</th><th>Paciente</th><th>Descrição</th><th>Forma</th><th className="num">Valor</th><th>Situação</th></tr></thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.id}>
                  <td className="mono">{formatDay(p.occurred_on)}</td>
                  <td><Link to={`/prontuario/${p.patient?.id}`}>{p.patient?.full_name}</Link></td>
                  <td>{p.description}</td>
                  <td>{methodLabel(p.method)}{p.installments > 1 ? ` · ${p.installments}x` : ''}</td>
                  <td className="num"><b>{formatMoney(p.amount)}</b></td>
                  <td>{p.status === 'pago' ? <span className="tag ok">Pago</span> : (
                    <button type="button" className="btn btn-sm" onClick={() => markPaid(p)}><Check /> Marcar pago</button>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length === 0 && <Empty>Nenhum lançamento no período.</Empty>}
        </div>
      </div>
    </div>
  );
}
