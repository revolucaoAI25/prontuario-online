import { useState } from 'react';
import { Merge, Trash2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { supabase } from '../lib/supabase.js';
import { useToast } from '../context/ToastContext.jsx';
import { Modal, Field } from './ui.jsx';
import { PatientPicker } from './PatientPicker.jsx';

const EMPTY = {
  full_name: '', phone: '', phone_alt: '', cpf: '', email: '', birth_date: '',
  profession: '', address: '', notes: '', allow_messages: true,
};

// Create or edit a patient. Only the name is required.
export function PatientForm({ patient, onClose, onSaved, onDeleted }) {
  const toast = useToast();
  const { isAdmin } = useAuth();
  const [form, setForm] = useState(() => ({ ...EMPTY, ...Object.fromEntries(Object.entries(patient ?? {}).map(([k, v]) => [k, v ?? ''])) }));
  const [saving, setSaving] = useState(false);
  const [merging, setMerging] = useState(false);
  const [other, setOther] = useState(null);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  async function save() {
    if (!form.full_name.trim()) return toast.error('Informe o nome do paciente.');
    setSaving(true);
    const row = {
      full_name: form.full_name.trim(),
      phone: form.phone.trim() || null,
      phone_alt: form.phone_alt.trim() || null,
      cpf: form.cpf.trim() || null,
      email: form.email.trim() || null,
      birth_date: form.birth_date || null,
      profession: form.profession.trim() || null,
      address: form.address.trim() || null,
      notes: form.notes.trim() || null,
      allow_messages: form.allow_messages,
    };
    const request = patient?.id
      ? supabase.from('patients').update(row).eq('id', patient.id).select().single()
      : supabase.from('patients').insert(row).select().single();
    const { data, error } = await request;
    setSaving(false);
    if (error) return toast.error(error);
    toast.info(patient?.id ? 'Cadastro atualizado.' : 'Paciente cadastrado.');
    onSaved(data);
  }

  // Admin only. Payments keep a patient from being deleted (they are the
  // clinic's financial history); everything else of theirs goes with them.
  async function remove() {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Apagar ${patient.full_name}? O prontuário, os agendamentos e os lembretes dele também serão apagados. Isso não tem volta.`)) return;
    const { error } = await supabase.from('patients').delete().eq('id', patient.id);
    if (error) {
      return toast.error(error.code === '23503'
        ? 'Este paciente tem lançamentos no financeiro. Apague os lançamentos (botão $) antes de apagar o cadastro.'
        : error);
    }
    toast.info('Paciente apagado.');
    onDeleted?.();
  }

  // Admin: another record of the same person comes into this one.
  async function merge() {
    if (!other || other.isNew) return toast.error('Escolha o outro cadastro.');
    if (other.id === patient.id) return toast.error('É o mesmo cadastro.');
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Juntar "${other.full_name}" neste cadastro?\n\nAtendimentos, prontuário, financeiro, lembretes e WhatsApp passam para ${patient.full_name}. O outro cadastro é apagado. Não dá para desfazer.`)) return;
    const { error } = await supabase.rpc('merge_patients', { p_keep: patient.id, p_drop: other.id });
    if (error) return toast.error(error);
    toast.info('Cadastros juntados.');
    const { data } = await supabase.from('patients').select().eq('id', patient.id).single();
    onSaved(data ?? patient);
  }

  if (merging) {
    return (
      <Modal title="Juntar com outro cadastro" onClose={() => setMerging(false)}
        footer={<><button type="button" className="btn" onClick={() => setMerging(false)}>Voltar</button><button type="button" className="btn btn-primary" onClick={merge}><Merge /> Juntar</button></>}>
        <div className="small muted" style={{ marginBottom: 12 }}>Escolha o cadastro repetido de {patient.full_name}. Tudo dele vem para este cadastro, que continua; o outro é apagado.</div>
        <Field label="Cadastro repetido"><PatientPicker value={other} onChange={setOther} autoFocus /></Field>
      </Modal>
    );
  }

  return (
    <Modal
      title={patient?.id ? 'Editar cadastro' : 'Novo paciente'}
      onClose={onClose}
      wide
      footer={<>
        {patient?.id && isAdmin && onDeleted && (
          <button type="button" className="btn btn-ghost" style={{ color: 'var(--danger)' }} onClick={remove}><Trash2 /> Apagar paciente</button>
        )}
        {patient?.id && isAdmin && (
          <button type="button" className="btn btn-ghost" style={{ marginRight: 'auto' }} onClick={() => setMerging(true)}><Merge /> Juntar com outro cadastro</button>
        )}
        <button type="button" className="btn" onClick={onClose}>Cancelar</button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>Salvar</button>
      </>}
    >
      <div className="form-grid">
        <Field label="Nome completo *" full><input className="input" autoFocus value={form.full_name} onChange={set('full_name')} /></Field>
        <Field label="Telefone (WhatsApp)"><input className="input" value={form.phone} onChange={set('phone')} placeholder="(31) 99999-9999" /></Field>
        <Field label="Outro telefone"><input className="input" value={form.phone_alt} onChange={set('phone_alt')} /></Field>
        <Field label="CPF"><input className="input" value={form.cpf} onChange={set('cpf')} placeholder="000.000.000-00" /></Field>
        <Field label="Data de nascimento"><input className="input" type="date" value={form.birth_date} onChange={set('birth_date')} /></Field>
        <Field label="E-mail"><input className="input" type="email" value={form.email} onChange={set('email')} /></Field>
        <Field label="Profissão"><input className="input" value={form.profession} onChange={set('profession')} /></Field>
        <Field label="Endereço" full><input className="input" value={form.address} onChange={set('address')} /></Field>
        <Field label="Observações" full><textarea className="textarea" value={form.notes} onChange={set('notes')} /></Field>
        <label className="check full">
          <input type="checkbox" checked={form.allow_messages} onChange={set('allow_messages')} />
          Aceita receber lembretes e mensagens de aniversário
        </label>
      </div>
    </Modal>
  );
}
