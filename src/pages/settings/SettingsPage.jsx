import { useState } from 'react';
import { UsersTab } from './UsersTab.jsx';
import { AgendasTab } from './AgendasTab.jsx';
import { ProceduresTab } from './ProceduresTab.jsx';
import { ShortcutsTab } from './ShortcutsTab.jsx';
import { IntegrationsTab } from './IntegrationsTab.jsx';

const TABS = [
  ['usuarios', 'Usuários', UsersTab],
  ['agendas', 'Agendas e horários', AgendasTab],
  ['procedimentos', 'Procedimentos e retornos', ProceduresTab],
  ['atalhos', 'Atalhos do prontuário', ShortcutsTab],
  ['integracoes', 'Lembretes e integrações', IntegrationsTab],
];

export function SettingsPage() {
  const [tab, setTab] = useState('usuarios');
  const Current = TABS.find(([id]) => id === tab)[2];
  return (
    <div className="page">
      <header className="topbar"><div><h1>Ajustes</h1><div className="sub">Somente o administrador vê esta área</div></div></header>
      <div className="tabs">
        {TABS.map(([id, label]) => <button key={id} type="button" className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}
      </div>
      <div className="scroll grow"><Current /></div>
    </div>
  );
}
