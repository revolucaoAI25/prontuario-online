import { useState } from 'react';
import { supabase } from '../lib/supabase.js';
import { useToast } from '../context/ToastContext.jsx';
import { Modal, Field } from './ui.jsx';

const EMPTY = {
  full_name: '', phone: '', phone_alt: '', cpf: '', email: '', birth_date: '',
  profession: '', address: '', notes: '', allow_messages: true,
};

// Create or edit a patient. Only the name is required.
export function PatientForm({ patient, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState(() => ({ ...EMPTY, ...Object.fromEntries(Object.entries(patient ?? {}).map(([k, v]) => [k, v ?? ''])) }));
  const [saving, setSaving] = useState(false);
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

  return (
    <Modal
      title={patient?.id ? 'Editar cadastro' : 'Novo paciente'}
      onClose={onClose}
      wide
      footer={<>
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
