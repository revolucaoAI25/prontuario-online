import { useEffect, useRef, useState } from 'react';
import { QrCode, RefreshCw, Unplug } from 'lucide-react';
import { callApi } from '../lib/supabase.js';
import { useToast } from '../context/ToastContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';

const STATE_LABEL = {
  open: ['Conectado', 'ok'],
  connecting: ['Aguardando leitura do QR Code', 'warn'],
  close: ['Desconectado', 'danger'],
  inexistente: ['Instância ainda não criada', 'warn'],
};

// Connect the clinic's WhatsApp to the Evolution API from inside the app:
// shows the QR code (refreshed while waiting) and the connection status.
// Anyone on the team can reconnect; only an admin can disconnect.
export function WhatsAppConnection({ onStatus, autoConnect = false }) {
  const toast = useToast();
  const { isAdmin } = useAuth();
  const [status, setStatus] = useState(null);
  const [qr, setQr] = useState(null);
  const [busy, setBusy] = useState(false);
  const qrAt = useRef(0);

  async function refreshStatus() {
    try {
      const s = await callApi('whatsapp/status');
      setStatus(s);
      onStatus?.(s);
      if (s.estado === 'open') setQr(null);
      return s;
    } catch (error) {
      setStatus({ erro: error.message });
      return null;
    }
  }

  async function connect() {
    setBusy(true);
    try {
      const r = await callApi('whatsapp/conectar');
      qrAt.current = Date.now();
      if (r.estado === 'open') {
        setQr(null);
        toast.info('O WhatsApp já está conectado.');
      } else {
        setQr({ image: r.qrcode, code: r.codigo_pareamento });
      }
      await refreshStatus();
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Desconectar o WhatsApp da clínica? As conversas param de aparecer no sistema até conectar de novo.')) return;
    try {
      await callApi('whatsapp/desconectar');
      await refreshStatus();
    } catch (error) {
      toast.error(error);
    }
  }

  useEffect(() => {
    refreshStatus().then((s) => {
      if (autoConnect && s?.configurado && s.estado !== 'open') connect();
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // While a QR code is on screen: poll the status, and fetch a fresh code
  // before the current one expires (~40 s).
  useEffect(() => {
    if (!qr) return undefined;
    const id = setInterval(async () => {
      const s = await refreshStatus();
      if (s?.estado === 'open') {
        toast.info('WhatsApp conectado!');
      } else if (Date.now() - qrAt.current > 30_000) {
        connect();
      }
    }, 4000);
    return () => clearInterval(id);
  }, [qr]); // eslint-disable-line react-hooks/exhaustive-deps

  const [label, tone] = STATE_LABEL[status?.estado] ?? ['—', ''];

  return (
    <div>
      {!status && <div className="small muted">Verificando…</div>}
      {status?.erro && <div className="banner">{status.erro}</div>}
      {status?.configurado === false && (
        <div className="banner">
          O servidor do WhatsApp ainda não foi configurado. Fale com o suporte técnico.
        </div>
      )}
      {status?.configurado && (
        <div className="stack">
          <div className="row">
            <span>Instância <b>{status.instancia}</b></span>
            <span className={`tag ${tone}`}>{label}</span>
            <span className="grow" />
            <button type="button" className="btn btn-sm" onClick={refreshStatus}><RefreshCw /> Atualizar</button>
          </div>
          <div className="row-wrap">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={connect}>
              <QrCode /> {status.estado === 'open' ? 'Verificar conexão' : 'Conectar (mostrar QR Code)'}
            </button>
            {status.estado === 'open' && isAdmin && <button type="button" className="btn btn-danger" onClick={disconnect}><Unplug /> Desconectar</button>}
          </div>
          {qr && (
            <div className="stack" style={{ alignItems: 'center', padding: 10 }}>
              {qr.image ? <img src={qr.image} alt="QR Code do WhatsApp" style={{ width: 260, height: 260 }} /> : <div className="small muted">Gerando QR Code…</div>}
              <div className="small" style={{ textAlign: 'center', maxWidth: 360 }}>
                No celular da clínica: WhatsApp → <b>Aparelhos conectados</b> → <b>Conectar um aparelho</b> e aponte para o código.
                {qr.code && <> Ou use o código de pareamento <b className="mono">{qr.code}</b>.</>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
