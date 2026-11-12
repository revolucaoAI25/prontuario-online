import { lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './context/AuthContext.jsx';
import { Layout } from './components/Layout.jsx';
import { LoginPage } from './pages/LoginPage.jsx';
import { AgendaPage } from './pages/agenda/AgendaPage.jsx';

// Screens other than the Agenda load when first opened (smaller first load).
const PatientsPage = lazy(() => import('./pages/PatientsPage.jsx').then((m) => ({ default: m.PatientsPage })));
const RecordPage = lazy(() => import('./pages/RecordPage.jsx').then((m) => ({ default: m.RecordPage })));
const RecordsPage = lazy(() => import('./pages/RecordsPage.jsx').then((m) => ({ default: m.RecordsPage })));
const AdminPage = lazy(() => import('./pages/AdminPage.jsx').then((m) => ({ default: m.AdminPage })));
const PeoplePage = lazy(() => import('./pages/PeoplePage.jsx').then((m) => ({ default: m.PeoplePage })));
const FinancePage = lazy(() => import('./pages/FinancePage.jsx').then((m) => ({ default: m.FinancePage })));
const StockPage = lazy(() => import('./pages/StockPage.jsx').then((m) => ({ default: m.StockPage })));
const ChatPage = lazy(() => import('./pages/ChatPage.jsx').then((m) => ({ default: m.ChatPage })));
const ConversationsPage = lazy(() => import('./pages/ConversationsPage.jsx').then((m) => ({ default: m.ConversationsPage })));
const RemindersPage = lazy(() => import('./pages/RemindersPage.jsx').then((m) => ({ default: m.RemindersPage })));
const SettingsPage = lazy(() => import('./pages/settings/SettingsPage.jsx').then((m) => ({ default: m.SettingsPage })));
const CampaignsPage = lazy(() => import('./pages/CampaignsPage.jsx').then((m) => ({ default: m.CampaignsPage })));

function AdminOnly({ children }) {
  const { isAdmin } = useAuth();
  return isAdmin ? children : <Navigate to="/agenda" replace />;
}

function SuperAdminOnly({ children }) {
  const { isSuperAdmin } = useAuth();
  return isSuperAdmin ? children : <Navigate to="/agenda" replace />;
}

function ReceptionOnly({ children }) {
  const { isReception } = useAuth();
  return isReception ? children : <Navigate to="/agenda" replace />;
}

export function App() {
  const { session, staff, loading } = useAuth();
  if (loading) return <div className="splash"><img src="/brand/logo-mark.png" alt="" /></div>;
  if (!session) return <LoginPage />;
  if (!staff || !staff.active) return <LoginPage noAccess />;

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/agenda" element={<AgendaPage />} />
        <Route path="/pacientes" element={<PatientsPage />} />
        <Route path="/prontuarios" element={<RecordsPage />} />
        <Route path="/prontuario/:patientId" element={<RecordPage />} />
        <Route path="/comunicacao" element={<ChatPage />} />
        <Route path="/conversas" element={<ConversationsPage />} />
        <Route path="/lembretes" element={<RemindersPage />} />
        <Route path="/estoque" element={<StockPage />} />
        <Route path="/financeiro" element={<ReceptionOnly><FinancePage /></ReceptionOnly>} />
        <Route path="/administrativo" element={<ReceptionOnly><AdminPage /></ReceptionOnly>} />
        <Route path="/pessoal" element={<AdminOnly><PeoplePage /></AdminOnly>} />
        <Route path="/configuracoes" element={<AdminOnly><SettingsPage /></AdminOnly>} />
        <Route path="/disparos" element={<SuperAdminOnly><CampaignsPage /></SuperAdminOnly>} />
        <Route path="*" element={<Navigate to="/agenda" replace />} />
      </Route>
    </Routes>
  );
}
