import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { supabase, must } from '../../lib/supabase.js';
import { useLoad } from '../../lib/hooks.js';
import { useToast } from '../../context/ToastContext.jsx';
import { Field } from '../../components/ui.jsx';

// The Financeiro password: four numbers, set by Dr. Everson, asked of
// everyone who opens that screen (him and the reception).
export function FinanceTab() {
  const toast = useToast();
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const { data: isSet, reload } = useLoad(() => must(supabase.rpc('finance_pin_is_set')), []);

  async function save() {
    if (!/^\d{4}$/.test(pin)) return toast.error('A senha tem 4 números.');
    if (pin !== again) return toast.error('As duas senhas não são iguais.');
    const { error } = await supabase.rpc('set_finance_pin', { p_pin: pin });
    if (error) return toast.error(error);
    setPin('');
    setAgain('');
    toast.info('Senha do Financeiro salva.');
    return reload();
  }

  const digits = (setter) => (e) => setter(e.target.value.replace(/\D/g, '').slice(0, 4));
  return (
    <div className="card card-pad" style={{ maxWidth: 560 }}>
      <div className="section-title"><KeyRound size={13} /> Senha do Financeiro</div>
      <div className="small muted" style={{ marginBottom: 14 }}>
        {isSet
          ? 'A tela Financeiro pede esta senha (você e a recepção). Para trocar, digite a nova senha duas vezes.'
          : 'Ainda sem senha: o Financeiro abre direto. Crie uma senha de 4 números.'}
        {' '}O Financeiro também não abre em celular.
      </div>
      <div className="form-grid">
        <Field label={isSet ? 'Nova senha' : 'Senha'}><input className="input" type="password" inputMode="numeric" autoComplete="new-password" value={pin} onChange={digits(setPin)} placeholder="4 números" /></Field>
        <Field label="Repita a senha"><input className="input" type="password" inputMode="numeric" autoComplete="new-password" value={again} onChange={digits(setAgain)} /></Field>
      </div>
      <button type="button" className="btn btn-primary" onClick={save}>Salvar senha</button>
    </div>
  );
}
