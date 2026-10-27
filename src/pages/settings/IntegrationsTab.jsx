import { useEffect, useState } from 'react';
import { supabase, must } from '../../lib/supabase.js';
import { useLoad } from '../../lib/hooks.js';
import { useToast } from '../../context/ToastContext.jsx';
import { Field } from '../../components/ui.jsx';

const KEYS = ['default_reminder_months', 'reminder_max_overdue_days', 'reminder_webhook_url', 'birthday_webhook_url'];

export function IntegrationsTab() {
  const toast = useToast();
  const { data } = useLoad(() => must(supabase.from('settings').select('*').in('key', KEYS)), []);
  const [form, setForm] = useState(null);

  useEffect(() => {
    if (data) setForm(Object.fromEntries(KEYS.map((k) => [k, data.find((r) => r.key === k)?.value ?? ''])));
  }, [data]);

  async function save() {
    try {
      const months = Number(form.default_reminder_months);
      const overdue = Number(form.reminder_max_overdue_days);
      if (!(months >= 1 && months <= 60)) throw new Error('Retorno padrão deve ser entre 1 e 60 meses.');
      if (!(overdue >= 0 && overdue <= 365)) throw new Error('Tolerância deve ser entre 0 e 365 dias.');
      for (const key of ['reminder_webhook_url', 'birthday_webhook_url']) {
        if (form[key] && !/^https:\/\//.test(form[key])) throw new Error('Os webhooks precisam começar com https://');
      }
      const rows = [
        { key: 'default_reminder_months', value: months },
        { key: 'reminder_max_overdue_days', value: overdue },
        { key: 'reminder_webhook_url', value: form.reminder_webhook_url || '' },
        { key: 'birthday_webhook_url', value: form.birthday_webhook_url || '' },
      ];
      for (const row of rows) await must(supabase.from('settings').update({ value: row.value }).eq('key', row.key));
      toast.info('Ajustes salvos.');
    } catch (error) {
      toast.error(error);
    }
  }

  if (!form) return null;
  const origin = window.location.origin;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="stack">
      <div className="card card-pad">
        <div className="section-title">Lembretes de retorno</div>
        <div className="form-grid">
          <Field label="Retorno padrão (meses)" hint="Para procedimentos sem prazo próprio.">
            <input className="input" type="number" min="1" max="60" value={form.default_reminder_months} onChange={set('default_reminder_months')} />
          </Field>
          <Field label="Tolerância de atraso (dias)" hint="Lembretes mais atrasados que isso não são enviados (ficam como “vencidos”).">
            <input className="input" type="number" min="0" max="365" value={form.reminder_max_overdue_days} onChange={set('reminder_max_overdue_days')} />
          </Field>
          <Field label="Webhook dos lembretes" full hint="Recebe um POST por lembrete devido (uma vez por dia).">
            <input className="input" value={form.reminder_webhook_url} onChange={set('reminder_webhook_url')} placeholder="https://..." />
          </Field>
          <Field label="Webhook de aniversário" full hint="Recebe um POST por aniversariante, no dia.">
            <input className="input" value={form.birthday_webhook_url} onChange={set('birthday_webhook_url')} placeholder="https://..." />
          </Field>
        </div>
        <button type="button" className="btn btn-primary" onClick={save}>Salvar</button>
      </div>
      <div className="card card-pad">
        <div className="section-title">API de agendamento</div>
        <div className="small">Endereço: <code>{origin}/api/agenda/…</code> — autenticação pelo cabeçalho <code>x-api-key</code> (variável <code>CLINIC_API_KEY</code> na Vercel). Documentação em <code>docs/API.md</code>.</div>
      </div>
      <div className="card card-pad">
        <div className="section-title">WhatsApp (Evolution API)</div>
        <div className="small">Configure o webhook da instância (evento <code>MESSAGES_UPSERT</code>) para:</div>
        <code className="small">{origin}/api/webhooks/evolution?secret=EVOLUTION_WEBHOOK_SECRET</code>
      </div>
    </div>
  );
}
