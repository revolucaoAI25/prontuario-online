import { useState } from 'react';
import { useAuth } from '../../context/AuthContext.jsx';
import { UsersTab } from './UsersTab.jsx';
import { AgendasTab } from './AgendasTab.jsx';
import { ProceduresTab } from './ProceduresTab.jsx';
import { ShortcutsTab } from './ShortcutsTab.jsx';
import { IntegrationsTab, RemindersTab } from './IntegrationsTab.jsx';

const TABS = [
  ['usuarios', 'Usuários', UsersTab],
  ['agendas', 'Agendas e horários', AgendasTab],
  ['procedimentos', 'Procedimentos e retornos', ProceduresTab],
  ['atalhos', 'Atalhos do prontuário', ShortcutsTab],
  ['lembretes', 'Lembretes', RemindersTab],
  // webhooks and API: the agency's super admin only
  ['integracoes', 'Integrações', IntegrationsTab, 'super'],
];

export function SettingsPage() {
  const { isSuperAdmin } = useAuth();
  const [tab, setTab] = useState('usuarios');
  const tabs = TABS.filter(([, , , only]) => !only || isSuperAdmin);
  const Current = (tabs.find(([id]) => id === tab) ?? tabs[0])[2];
  return (
    <div className="page">
      <header className="topbar"><div><h1>Ajustes</h1><div className="sub">Somente o administrador vê esta área</div></div></header>
      <div className="tabs">
        {tabs.map(([id, label]) => <button key={id} type="button" className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}
      </div>
      <div className="scroll grow"><Current /></div>
    </div>
  );
}
