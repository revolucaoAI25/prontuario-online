import { useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';

export function LoginPage({ noAccess }) {
  const { signIn, signOut } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const { error: err } = await signIn(email.trim(), password);
    setBusy(false);
    if (err) setError('E-mail ou senha incorretos.');
  }

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <div className="row" style={{ marginBottom: 18 }}>
          <div className="avatar lg" style={{ background: 'var(--brand)', color: '#fff', borderRadius: 14 }}>CR</div>
          <div>
            <h1 style={{ fontSize: 18 }}>Clínica Rezeck</h1>
            <div className="small muted">Agenda e prontuário</div>
          </div>
        </div>
        {noAccess ? (
          <>
            <div className="banner" style={{ marginBottom: 12 }}>Seu login ainda não tem acesso ao sistema. Peça ao Dr. Everson para liberar.</div>
            <button type="button" className="btn" onClick={signOut}>Sair</button>
          </>
        ) : (
          <>
            <div className="field"><label htmlFor="email">E-mail</label>
              <input id="email" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
            </div>
            <div className="field"><label htmlFor="password">Senha</label>
              <input id="password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            {error && <div className="field-error">{error}</div>}
            <button type="submit" className="btn btn-primary" style={{ width: '100%' }} disabled={busy}>Entrar</button>
          </>
        )}
      </form>
    </div>
  );
}
