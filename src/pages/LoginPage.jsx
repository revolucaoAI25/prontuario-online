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
      <div className="login-brand">
        <img src="/brand/logo.png" alt="Everson Rezeck · Medicina Estética" />
      </div>
      <div className="login-side">
        <form className="login-card" onSubmit={submit}>
          <h1>{noAccess ? 'Acesso pendente' : 'Bem-vindo(a)'}</h1>
          <div className="sub">{noAccess ? 'Seu login ainda não tem acesso ao sistema.' : 'Entre com seu e-mail e senha da clínica.'}</div>
          {noAccess ? (
            <>
              <div className="banner" style={{ marginBottom: 16 }}>Peça ao Dr. Everson para liberar o seu acesso em Ajustes → Usuários.</div>
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
              <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
            </>
          )}
        </form>
      </div>
    </div>
  );
}
