import { useState } from 'react';
import { addDays, formatDay, localDay } from '../../lib/time.js';

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

// Period chooser shared by the report and the expenses.
export function usePeriod(initial = 'mes') {
  const [preset, setPreset] = useState(initial);
  const [custom, setCustom] = useState(() => monthRange(0));
  const [from, to] = preset === 'custom' ? custom : PRESETS[preset]();
  const picker = (
    <div className="row-wrap">
      <div className="seg">
        {[['hoje', 'Hoje'], ['ontem', 'Ontem'], ['mes', 'Este mês'], ['mes_passado', 'Mês passado'], ['custom', 'Período']].map(([id, label]) => (
          <button key={id} type="button" className={preset === id ? 'active' : ''} onClick={() => setPreset(id)}>{label}</button>
        ))}
      </div>
      {preset === 'custom' && (
        <div className="row">
          <input className="input" type="date" value={custom[0]} onChange={(e) => setCustom([e.target.value, custom[1]])} aria-label="De" />
          <input className="input" type="date" value={custom[1]} onChange={(e) => setCustom([custom[0], e.target.value])} aria-label="Até" />
        </div>
      )}
    </div>
  );
  return { from, to, picker, label: from === to ? formatDay(from) : `${formatDay(from)} a ${formatDay(to)}` };
}
