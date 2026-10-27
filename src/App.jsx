import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './context/AuthContext.jsx';
import { Layout } from './components/Layout.jsx';
import { LoginPage } from './pages/LoginPage.jsx';
import { AgendaPage } from './pages/agenda/AgendaPage.jsx';
import { PatientsPage } from './pages/PatientsPage.jsx';
import { RecordPage } from './pages/RecordPage.jsx';
import { RecordsPage } from './pages/RecordsPage.jsx';
import { FinancePage } from './pages/FinancePage.jsx';
import { StockPage } from './pages/StockPage.jsx';
import { ChatPage } from './pages/ChatPage.jsx';
import { ConversationsPage } from './pages/ConversationsPage.jsx';
import { RemindersPage } from './pages/RemindersPage.jsx';
import { SettingsPage } from './pages/settings/SettingsPage.jsx';

function AdminOnly({ children }) {
  const { isAdmin } = useAuth();
  return isAdmin ? children : <Navigate to="/agenda" replace />;
}

export function App() {
  const { session, staff, loading } = useAuth();
  if (loading) return <div className="empty">Carregando…</div>;
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
        <Route path="/financeiro" element={<AdminOnly><FinancePage /></AdminOnly>} />
        <Route path="/configuracoes" element={<AdminOnly><SettingsPage /></AdminOnly>} />
        <Route path="*" element={<Navigate to="/agenda" replace />} />
      </Route>
    </Routes>
  );
}
