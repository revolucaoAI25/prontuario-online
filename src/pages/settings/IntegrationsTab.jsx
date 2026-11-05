import { useEffect, useState } from 'react';
import { supabase, must } from '../../lib/supabase.js';
import { useLoad } from '../../lib/hooks.js';
import { useToast } from '../../context/ToastContext.jsx';
import { Field } from '../../components/ui.jsx';

function useSettings(keys) {
  const toast = useToast();
  const { data } = useLoad(() => must(supabase.from('settings').select('*').in('key', keys)), []);
  const [form, setForm] = useState(null);
  useEffect(() => {
    if (data) setForm(Object.fromEntries(keys.map((k) => [k, data.find((r) => r.key === k)?.value ?? ''])));
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(rows) {
    try {
      for (const row of rows) await must(supabase.from('settings').update({ value: row.value }).eq('key', row.key));
      toast.info('Ajustes salvos.');
    } catch (error) {
      toast.error(error);
    }
  }
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return { form, set, save, toast };
}

// Return periods: the clinic's admin.
export function RemindersTab() {
  const { form, set, save, toast } = useSettings(['default_reminder_months', 'reminder_max_overdue_days']);
  if (!form) return null;

  function submit() {
    const months = Number(form.default_reminder_months);
    const overdue = Number(form.reminder_max_overdue_days);
    if (!(months >= 1 && months <= 60)) return toast.error('Retorno padrão deve ser entre 1 e 60 meses.');
    if (!(overdue >= 0 && overdue <= 365)) return toast.error('Tolerância deve ser entre 0 e 365 dias.');
    return save([{ key: 'default_reminder_months', value: months }, { key: 'reminder_max_overdue_days', value: overdue }]);
  }

  return (
    <div className="card card-pad">
      <div className="section-title">Lembretes de retorno</div>
      <div className="form-grid">
        <Field label="Retorno padrão (meses)" hint="Para procedimentos sem prazo próprio (os prazos de cada um ficam em Procedimentos e retornos).">
          <input className="input" type="number" min="1" max="60" value={form.default_reminder_months} onChange={set('default_reminder_months')} />
        </Field>
        <Field label="Tolerância de atraso (dias)" hint="Lembretes mais atrasados que isso não são enviados (ficam como “vencidos”).">
          <input className="input" type="number" min="0" max="365" value={form.reminder_max_overdue_days} onChange={set('reminder_max_overdue_days')} />
        </Field>
      </div>
      <button type="button" className="btn btn-primary" onClick={submit}>Salvar</button>
    </div>
  );
}

// Webhooks and the API: the agency's super admin.
const HOOKS = ['reminder_webhook_url', 'birthday_webhook_url', 'no_show_webhook_url'];

export function IntegrationsTab() {
  const { form, set, save, toast } = useSettings([...HOOKS, 'no_show_delay_minutes', 'app_url']);
  if (!form) return null;
  const origin = window.location.origin;

  function submit() {
    for (const key of HOOKS) {
      if (form[key] && !/^https:\/\//.test(form[key])) return toast.error('Os webhooks precisam começar com https://');
    }
    const hours = Number(String(form.no_show_hours ?? Number(form.no_show_delay_minutes || 120) / 60).replace(',', '.'));
    if (!(hours >= 0.5 && hours <= 12)) return toast.error('O aviso de falta deve sair entre 0,5 e 12 horas depois do horário.');
    return save([
      ...HOOKS.map((key) => ({ key, value: form[key] || '' })),
      { key: 'no_show_delay_minutes', value: Math.round(hours * 60) },
      // The database job calls this address (…/api/cron/faltas). Saved from
      // the address the super admin is using, so it follows a domain change.
      ...(/^https:\/\//.test(origin) ? [{ key: 'app_url', value: origin }] : []),
    ]);
  }

  const hours = form.no_show_hours ?? String(Number(form.no_show_delay_minutes || 120) / 60).replace('.', ',');

  return (
    <div className="stack">
      <div className="small muted">Visível só para o super admin (suporte técnico).</div>
      <div className="card card-pad">
        <div className="section-title">Webhooks</div>
        <div className="form-grid">
          <Field label="Webhook dos lembretes" full hint="Recebe um POST por lembrete devido (uma vez por dia). Formato em docs/WEBHOOKS.md.">
            <input className="input" value={form.reminder_webhook_url} onChange={set('reminder_webhook_url')} placeholder="https://..." />
          </Field>
          <Field label="Webhook de aniversário" full hint="Recebe um POST por aniversariante, no dia.">
            <input className="input" value={form.birthday_webhook_url} onChange={set('birthday_webhook_url')} placeholder="https://..." />
          </Field>
          <Field label="Webhook de falta" hint="Recebe um POST quando o paciente não foi marcado como “Chegou” depois do tempo ao lado. Uma vez por agendamento.">
            <input className="input" value={form.no_show_webhook_url} onChange={set('no_show_webhook_url')} placeholder="https://..." />
          </Field>
          <Field label="Avisar a falta depois de (horas)" hint="Contado a partir do horário marcado. Padrão: 2 horas.">
            <input className="input" inputMode="decimal" value={hours} onChange={set('no_show_hours')} />
          </Field>
        </div>
        <button type="button" className="btn btn-primary" onClick={submit}>Salvar</button>
      </div>
      <div className="card card-pad">
        <div className="section-title">API de agendamento</div>
        <div className="small">Endereço: <code>{origin}/api/agenda/…</code> e <code>{origin}/api/pacientes/…</code> — autenticação pelo cabeçalho <code>x-api-key</code> (variável <code>CLINIC_API_KEY</code> na Vercel). Documentação em <code>docs/API.md</code>.</div>
      </div>
    </div>
  );
}
