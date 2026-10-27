import { createContext, useCallback, useContext, useState } from 'react';
import { errorMessage } from '../lib/format.js';

const ToastContext = createContext(null);
let nextId = 1;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => setToasts((all) => all.filter((t) => t.id !== id)), []);

  const show = useCallback((message, { kind = 'info', action, duration = 4000 } = {}) => {
    const id = nextId++;
    setToasts((all) => [...all, { id, message, kind, action }]);
    setTimeout(() => dismiss(id), action ? 7000 : duration);
  }, [dismiss]);

  const api = {
    info: (message, options) => show(message, options),
    error: (error) => show(typeof error === 'string' ? error : errorMessage(error), { kind: 'error', duration: 6000 }),
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="status">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind === 'error' ? 'error' : ''}`}>
            <span>{t.message}</span>
            {t.action && (
              <button type="button" onClick={() => { t.action.onClick(); dismiss(t.id); }}>{t.action.label}</button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
