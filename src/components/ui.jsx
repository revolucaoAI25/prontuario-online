import { useEffect } from 'react';
import { X } from 'lucide-react';
import { initials } from '../lib/format.js';
import { statusLabel } from '../lib/status.js';

export function Avatar({ name, size }) {
  return <span className={`avatar ${size === 'lg' ? 'lg' : ''}`}>{initials(name)}</span>;
}

export function StatusPill({ status }) {
  return (
    <span className={`status-pill st-${status}`}>
      <span className="dot" />
      {statusLabel(status)}
    </span>
  );
}

export function Modal({ title, onClose, children, footer, wide }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <div className="overlay" onClick={onClose} />
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Fechar"><X /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </>
  );
}

export function Field({ label, children, full, hint }) {
  return (
    <div className={`field ${full ? 'full' : ''}`}>
      <label>{label}</label>
      {children}
      {hint && <span className="small muted">{hint}</span>}
    </div>
  );
}

export function Empty({ children }) {
  return <div className="empty">{children}</div>;
}
