import { useEffect, useState } from 'react';
import { CheckCircle2, ImageOff, Send, XCircle } from 'lucide-react';
import { callApi } from '../lib/supabase.js';

// "Enviar teste": the webhook gets the same JSON as a real send, with a
// made-up patient and "teste": true; optionally your phone, to see the
// message arrive. Shows what came back and what was sent. tipo: campanha,
// lembrete, aniversario or falta (super admin only). imageUrl goes as
// "imagem_url", as in a real send.
export function WebhookTester({ url, tipo = 'campanha', name, message, imageUrl, compact = false }) {
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [showJson, setShowJson] = useState(false);

  async function run() {
    setBusy(true);
    setResult(null);
    try {
      setResult(await callApi('admin/testar_webhook', {
        tipo, url: url.trim(), nome: name, mensagem: message, imagem_url: imageUrl?.trim() || undefined, telefone: phone.trim() || undefined,
      }));
    } catch (error) {
      setResult({ recebido: false, erro: error.message });
    } finally {
      setBusy(false);
    }
  }

  const secs = (ms) => `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
  return (
    <div className="webhook-test">
      <div className="row-wrap" style={{ gap: 8 }}>
        <input className="input" style={{ width: 230 }} value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel"
          placeholder="Seu WhatsApp (opcional)" aria-label="Telefone para o teste" />
        <button type="button" className="btn btn-sm" disabled={busy || !/^https?:\/\//.test(url.trim())} onClick={run}>
          <Send /> {busy ? 'Enviando… (até 30 s)' : 'Enviar teste'}
        </button>
        {!compact && <span className="small muted grow">Vai com um paciente fictício e <span className="mono">"teste": true</span>. Com o seu telefone, a mensagem chega para você.</span>}
      </div>
      {result && (
        <div className={`webhook-result ${result.recebido ? 'ok' : 'fail'}`}>
          <div className="row" style={{ gap: 6 }}>
            {result.recebido ? <CheckCircle2 /> : <XCircle />}
            <b>
              {result.recebido
                ? `Webhook recebeu: resposta ${result.status_http} em ${secs(result.tempo_ms)}`
                : result.incerto
                  ? `${result.erro}. Confira se chegou${tipo === 'campanha' ? ': em um disparo, isso conta como enviado sem confirmação (não reenvia).' : '.'}`
                  : `Falhou: ${result.erro}${result.tempo_ms != null ? ` (${secs(result.tempo_ms)})` : ''}`}
            </b>
          </div>
          {result.recebido && result.tempo_ms > 20000 && (
            <div className="small">{tipo === 'campanha'
              ? 'Demorou para responder. Acima de 30 s o disparo conta como enviado sem confirmação (e não reenvia).'
              : 'Demorou para responder. Acima de 10 s o envio conta como falha e é tentado de novo mais tarde.'}</div>
          )}
          {result.resposta && <pre className="webhook-pre">{result.resposta}</pre>}
          {result.enviado && (
            <button type="button" className="link-btn small" onClick={() => setShowJson((v) => !v)}>{showJson ? 'esconder o JSON enviado' : 'ver o JSON enviado'}</button>
          )}
          {showJson && result.enviado && <pre className="webhook-pre">{JSON.stringify(result.enviado, null, 2)}</pre>}
        </div>
      )}
    </div>
  );
}

export const isImageUrl = (value) => /^https?:\/\/\S+$/.test(String(value ?? '').trim());

// The address of a hosted image (sent as "imagem_url"), with a preview so a
// wrong link shows up before sending.
export function ImageUrlInput({ value, onChange }) {
  const url = String(value ?? '').trim();
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);
  return (
    <div className="image-url-input">
      <input className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value)} inputMode="url" placeholder="https://.../imagem.jpg" />
      {isImageUrl(url) && (broken
        ? <div className="small image-url-broken"><ImageOff /> Não foi possível abrir essa imagem. Confira se o link é público e aponta direto para a imagem.</div>
        : <a href={url} target="_blank" rel="noreferrer" className="image-url-preview"><img src={url} alt="Prévia da imagem" onError={() => setBroken(true)} /></a>)}
    </div>
  );
}
