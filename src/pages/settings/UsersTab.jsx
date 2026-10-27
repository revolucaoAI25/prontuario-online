import { useState } from 'react';
import { KeyRound, Plus } from 'lucide-react';
import { callApi, supabase, must } from '../../lib/supabase.js';
import { useLoad } from '../../lib/hooks.js';
import { useToast } from '../../context/ToastContext.jsx';
import { ROLE_LABEL } from '../../lib/format.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { Empty, Field, Modal } from '../../components/ui.jsx';

const roleLabel = (u) => (u.is_superadmin ? 'Super admin (suporte)' : ROLE_LABEL[u.role]);

function UserModal({ user, agendas, onClose, onSaved }) {
  const toast = useToast();
  const { isSuperAdmin } = useAuth();
  const [form, setForm] = useState({
    nome: user?.full_name ?? '', email: user?.email ?? '', senha: '', papel: user?.role ?? 'secretaria', agenda_id: user?.agenda_id ?? '',
    super_admin: Boolean(user?.is_superadmin),
  });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function save() {
    try {
      const superAdmin = isSuperAdmin ? { super_admin: form.papel === 'admin' && form.super_admin } : {};
      if (user) await callApi('admin/atualizar_usuario', { id: user.id, nome: form.nome, papel: form.papel, agenda_id: form.agenda_id || null, ...superAdmin });
      else await callApi('admin/criar_usuario', { ...form, ...superAdmin });
      toast.info(user ? 'Usuário atualizado.' : 'Usuário criado. Passe o e-mail e a senha para a pessoa.');
      onSaved();
    } catch (error) {
      toast.error(error);
    }
  }

  return (
    <Modal title={user ? 'Editar usuário' : 'Novo usuário'} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancelar</button><button type="button" className="btn btn-primary" onClick={save}>Salvar</button></>}>
      <Field label="Nome"><input className="input" autoFocus value={form.nome} onChange={set('nome')} /></Field>
      {!user && <>
        <Field label="E-mail (login)"><input className="input" type="email" value={form.email} onChange={set('email')} /></Field>
        <Field label="Senha inicial" hint="Mínimo de 8 caracteres."><input className="input" value={form.senha} onChange={set('senha')} /></Field>
      </>}
      <Field label="Papel" hint="Administrador vê o Financeiro e os Ajustes. Secretária vê todos os grupos da equipe.">
        <select className="select" value={form.papel} onChange={set('papel')}>
          {Object.entries(ROLE_LABEL).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </Field>
      {isSuperAdmin && form.papel === 'admin' && (
        <label className="row small" style={{ gap: 8, marginBottom: 12 }}>
          <input type="checkbox" checked={form.super_admin} onChange={(e) => setForm({ ...form, super_admin: e.target.checked })} />
          Super admin (suporte técnico: também configura webhooks, WhatsApp e API)
        </label>
      )}
      <Field label="Agenda própria" hint="Profissionais veem o grupo da equipe da sua agenda.">
        <select className="select" value={form.agenda_id} onChange={set('agenda_id')}>
          <option value="">—</option>
          {agendas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </Field>
    </Modal>
  );
}

export function UsersTab() {
  const toast = useToast();
  const { isSuperAdmin } = useAuth();
  const [editing, setEditing] = useState(null);
  const { data, reload, error } = useLoad(() => callApi('admin/usuarios'), []);
  const { data: agendas = [] } = useLoad(() => must(supabase.from('agendas').select('id, name').eq('active', true).order('sort_order')), []);

  async function toggle(user) {
    try {
      await callApi('admin/atualizar_usuario', { id: user.id, ativo: !user.active });
      reload();
    } catch (err) {
      toast.error(err);
    }
  }

  async function resetPassword(user) {
    // eslint-disable-next-line no-alert
    const senha = window.prompt(`Nova senha para ${user.full_name} (mínimo 8 caracteres):`);
    if (!senha) return;
    try {
      await callApi('admin/redefinir_senha', { id: user.id, senha });
      toast.info('Senha alterada.');
    } catch (err) {
      toast.error(err);
    }
  }

  return (
    <div className="card">
      <div className="row" style={{ padding: '12px 14px' }}>
        <div className="section-title" style={{ margin: 0 }}>Pessoas com acesso ao sistema</div>
        <span className="grow" />
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing({})}><Plus /> Novo usuário</button>
      </div>
      {error && <div className="banner" style={{ margin: 14 }}>{error.message}</div>}
      <table className="table">
        <thead><tr><th>Nome</th><th>E-mail</th><th>Papel</th><th>Agenda</th><th /></tr></thead>
        <tbody>
          {(data?.usuarios ?? []).map((u) => (
            <tr key={u.id} style={{ opacity: u.active ? 1 : 0.5 }}>
              <td style={{ fontWeight: 700 }}>{u.full_name}</td>
              <td>{u.email}</td>
              <td>{roleLabel(u)}</td>
              <td>{u.agenda_name ?? '—'}</td>
              <td>
                {u.is_superadmin && !isSuperAdmin ? <span className="small muted">Login do suporte técnico</span> : (
                <div className="row">
                  <button type="button" className="btn btn-sm" onClick={() => setEditing(u)}>Editar</button>
                  <button type="button" className="btn btn-sm" onClick={() => resetPassword(u)}><KeyRound /> Senha</button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => toggle(u)}>{u.active ? 'Desativar' : 'Reativar'}</button>
                </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data && data.usuarios.length === 0 && <Empty>Nenhum usuário.</Empty>}
      {editing && (
        <UserModal user={editing.id ? editing : null} agendas={agendas} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />
      )}
    </div>
  );
}
