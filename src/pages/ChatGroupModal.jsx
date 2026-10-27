import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { supabase, must } from '../lib/supabase.js';
import { useLoad } from '../lib/hooks.js';
import { useToast } from '../context/ToastContext.jsx';
import { Field, Modal } from '../components/ui.jsx';
import { ROLE_LABEL } from '../lib/format.js';

// Create, rename, choose who takes part in, or delete a team group (admin).
// Admins and secretaries see every group anyway; this picks the others.
export function ChatGroupModal({ channel, onClose, onSaved, onDeleted }) {
  const toast = useToast();
  const [name, setName] = useState(channel?.name ?? '');
  const [everyone, setEveryone] = useState(channel ? channel.everyone : true);
  const [members, setMembers] = useState(null);
  const [saving, setSaving] = useState(false);

  const { data: staff = [] } = useLoad(() => must(supabase.from('staff').select('id, full_name, role, agenda_id').eq('active', true).order('full_name')), []);
  useLoad(async () => {
    if (!channel) return setMembers([]);
    const rows = await must(supabase.from('chat_channel_members').select('staff_id').eq('channel_id', channel.id));
    setMembers(rows.map((r) => r.staff_id));
    return rows;
  }, [channel?.id]);

  const others = staff.filter((s) => s.role === 'profissional');
  const toggle = (id) => setMembers((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]));

  async function save() {
    if (!name.trim()) return toast.error('Dê um nome ao grupo.');
    setSaving(true);
    try {
      let id = channel?.id;
      if (id) {
        await must(supabase.from('chat_channels').update({ name: name.trim(), everyone }).eq('id', id));
      } else {
        id = (await must(supabase.from('chat_channels').insert({ name: name.trim(), everyone }).select('id').single())).id;
      }
      await must(supabase.from('chat_channel_members').delete().eq('channel_id', id));
      if (!everyone && members?.length) await must(supabase.from('chat_channel_members').insert(members.map((staffId) => ({ channel_id: id, staff_id: staffId }))));
      toast.info(channel ? 'Grupo atualizado.' : 'Grupo criado.');
      onSaved(id);
    } catch (error) {
      toast.error(/duplicate|unique/i.test(error.message ?? '') ? 'Já existe um grupo com esse nome.' : error);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Apagar o grupo "${channel.name}" e todas as mensagens dele?`)) return;
    const { error } = await supabase.from('chat_channels').delete().eq('id', channel.id);
    if (error) return toast.error(error);
    toast.info('Grupo apagado.');
    onDeleted();
  }

  return (
    <Modal
      title={channel ? 'Editar grupo' : 'Novo grupo'}
      onClose={onClose}
      footer={<>
        {channel && <button type="button" className="btn btn-ghost" style={{ color: 'var(--danger)', marginRight: 'auto' }} onClick={remove}><Trash2 /> Apagar grupo</button>}
        <button type="button" className="btn" onClick={onClose}>Cancelar</button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>{channel ? 'Salvar' : 'Criar grupo'}</button>
      </>}
    >
      <Field label="Nome do grupo"><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="ex.: Avisos gerais" /></Field>
      <div className="field">
        <label>Quem participa</label>
        <label className="check"><input type="radio" checked={everyone} onChange={() => setEveryone(true)} /> Toda a equipe</label>
        <label className="check"><input type="radio" checked={!everyone} onChange={() => setEveryone(false)} /> Administradores, secretárias e as pessoas escolhidas</label>
      </div>
      {!everyone && (
        <div className="stack" style={{ gap: 6, padding: '4px 0 8px 24px' }}>
          {others.length === 0 && <div className="small muted">Não há profissionais cadastrados além de administradores e secretárias.</div>}
          {others.map((s) => (
            <label key={s.id} className="check"><input type="checkbox" checked={members?.includes(s.id) ?? false} onChange={() => toggle(s.id)} /> {s.full_name} <span className="small muted">· {ROLE_LABEL[s.role]}</span></label>
          ))}
        </div>
      )}
      {channel?.agenda_id && <div className="small muted">Este é o grupo de uma agenda: a profissional dessa agenda sempre participa.</div>}
    </Modal>
  );
}
