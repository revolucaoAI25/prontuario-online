import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { supabase, must } from '../../lib/supabase.js';
import { useLoad } from '../../lib/hooks.js';
import { useToast } from '../../context/ToastContext.jsx';
import { ROLE_LABEL } from '../../lib/format.js';
import { formatDay, localDay } from '../../lib/time.js';
import { Empty } from '../../components/ui.jsx';

const digits = (setter) => (e) => setter(e.target.value.replace(/\D/g, '').slice(0, 4));

function PinRow({ person, onChanged }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');

  async function save() {
    if (!/^\d{4}$/.test(pin)) return toast.error('A senha tem 4 números.');
    if (pin !== again) return toast.error('As duas senhas não são iguais.');
    const { error } = await supabase.rpc('set_staff_finance_pin', { p_staff_id: person.staff_id, p_pin: pin });
    if (error) return toast.error(error);
    toast.info(`Senha de ${person.full_name} salva.`);
    setEditing(false);
    setPin('');
    setAgain('');
    return onChanged();
  }

  async function remove() {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Tirar a senha de ${person.full_name}? Sem senha, ${person.role === 'admin' ? 'o administrador entra direto' : 'a pessoa não consegue abrir o Financeiro'}.`)) return null;
    const { error } = await supabase.rpc('set_staff_finance_pin', { p_staff_id: person.staff_id, p_pin: null });
    if (error) return toast.error(error);
    toast.info('Senha removida.');
    return onChanged();
  }

  return (
    <div className="pin-row">
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <div className="grow" style={{ minWidth: 180 }}>
          <b>{person.full_name}</b>
          <div className="small muted">
            {ROLE_LABEL[person.role]} · {person.has_pin ? `com senha${person.updated_at ? ` desde ${formatDay(localDay(person.updated_at))}` : ''}` : 'sem senha'}
          </div>
        </div>
        {!editing && <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>{person.has_pin ? 'Trocar senha' : 'Criar senha'}</button>}
        {!editing && person.has_pin && <button type="button" className="btn btn-sm btn-ghost" onClick={remove}>Tirar senha</button>}
      </div>
      {editing && (
        <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <input className="input" style={{ width: 130 }} type="password" inputMode="numeric" autoComplete="new-password" autoFocus value={pin} onChange={digits(setPin)} placeholder="4 números" aria-label="Nova senha" />
          <input className="input" style={{ width: 130 }} type="password" inputMode="numeric" autoComplete="new-password" value={again} onChange={digits(setAgain)} placeholder="Repita" aria-label="Repita a senha"
            onKeyDown={(e) => { if (e.key === 'Enter') save(); }} />
          <button type="button" className="btn btn-sm btn-primary" onClick={save}>Salvar</button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setEditing(false); setPin(''); setAgain(''); }}>Cancelar</button>
        </div>
      )}
    </div>
  );
}

// Financeiro passwords: four numbers per person, set by Dr. Everson. Each
// person types their own to open the Financeiro.
export function FinanceTab() {
  const toast = useToast();
  const { data: people = [], reload } = useLoad(() => must(supabase.rpc('finance_pin_people')), []);
  const { data: general, reload: reloadGeneral } = useLoad(() => must(supabase.rpc('finance_general_pin_is_set')), []);

  async function removeGeneral() {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Apagar a senha única antiga? Depois disso, só entra no Financeiro quem tiver senha própria (o administrador sem senha entra direto).')) return null;
    const { error } = await supabase.rpc('remove_general_finance_pin');
    if (error) return toast.error(error);
    toast.info('Senha única apagada.');
    return reloadGeneral();
  }

  return (
    <div className="card card-pad" style={{ maxWidth: 640 }}>
      <div className="section-title"><KeyRound size={13} /> Senhas do Financeiro</div>
      <div className="small muted" style={{ marginBottom: 14 }}>
        Cada pessoa tem a sua senha de 4 números para abrir o Financeiro. Quem não tem senha não entra (o administrador sem senha entra direto).
        A recepção vê os valores de todas as agendas, menos a do Dr. Everson. No celular, o Financeiro abre só para o administrador.
      </div>
      {people.length === 0 && <Empty>Nenhum usuário com acesso ao Financeiro.</Empty>}
      {people.map((p) => <PinRow key={p.staff_id} person={p} onChanged={reload} />)}
      {general && (
        <div className="banner info row" style={{ marginTop: 14, gap: 10 }}>
          <span className="grow small">Ainda existe a senha única antiga, que vale para quem não tem senha própria.</span>
          <button type="button" className="btn btn-sm" onClick={removeGeneral}>Apagar senha única</button>
        </div>
      )}
    </div>
  );
}
