import { useEffect, useRef, useState } from 'react';
import { Lock, MonitorSmartphone } from 'lucide-react';
import { supabase } from '../../lib/supabase.js';
import { isMobileDevice } from '../../lib/device.js';
import { Empty } from '../../components/ui.jsx';
import { useAuth } from '../../context/AuthContext.jsx';

const KEY = 'financeiro.liberado';
const IDLE_MS = 30 * 60 * 1000; // asks again after 30 minutes away from it

function unlockedRecently() {
  try {
    return Date.now() - Number(sessionStorage.getItem(KEY) ?? 0) < IDLE_MS;
  } catch {
    return false;
  }
}
function remember() {
  try { sessionStorage.setItem(KEY, String(Date.now())); } catch { /* asks every time */ }
}

// The Financeiro opens with each person's four-digit password (set by Dr.
// Everson in Ajustes → Financeiro). On a phone it opens only for the
// administrator. The figures themselves are protected by the database; this
// is the door.
export function FinanceGate({ children }) {
  const { isAdmin } = useAuth();
  const [state, setState] = useState(() => (unlockedRecently() ? 'open' : 'locked'));
  const [pin, setPin] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef(null);

  // Keep it open while it is being used.
  useEffect(() => {
    if (state !== 'open') return undefined;
    remember();
    const touch = () => remember();
    window.addEventListener('pointerdown', touch);
    return () => window.removeEventListener('pointerdown', touch);
  }, [state]);

  async function submit(value) {
    setBusy(true);
    const { data, error } = await supabase.rpc('check_finance_pin', { p_pin: value });
    setBusy(false);
    if (error) return setMessage('Não foi possível conferir a senha. Tente de novo.');
    if (data === 'ok') return setState('open');
    setPin('');
    setMessage(data === 'aguarde' ? 'Muitas tentativas. Espere 10 minutos e tente de novo.'
      : data === 'sem_senha' ? 'Você ainda não tem senha do Financeiro. Peça ao Dr. Everson para criar (Ajustes → Financeiro).'
        : 'Senha errada.');
    input.current?.focus();
    return null;
  }

  function change(e) {
    const value = e.target.value.replace(/\D/g, '').slice(0, 4);
    setPin(value);
    setMessage('');
    if (value.length === 4) submit(value);
  }

  if (isMobileDevice() && !isAdmin) {
    return <Empty icon={MonitorSmartphone}>O Financeiro abre só no computador da clínica.</Empty>;
  }
  if (state === 'open') return children;
  return (
    <div className="pin-gate">
      <div className="card card-pad pin-card">
        <Lock />
        <h2>Financeiro</h2>
        <div className="small muted">Digite a sua senha de 4 números.</div>
        <input
          ref={input}
          className="input pin-input"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          autoFocus
          maxLength={4}
          value={pin}
          disabled={busy}
          onChange={change}
          aria-label="Senha do Financeiro"
        />
        {message && <div className="field-error" role="alert">{message}</div>}
      </div>
    </div>
  );
}
