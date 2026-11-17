// What each webhook receives: one flat level of plain fields (text or
// number), so tools like Chatflux and n8n can pick each one as a variable.
// Dates are dd/mm/aaaa; a missing piece is an empty text. The same builders
// serve the real sends and the "Enviar teste" buttons.

export const brDay = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '');
const daysSince = (iso) => (iso ? Math.max(0, Math.round((Date.now() - new Date(`${String(iso).slice(0, 10)}T12:00:00-03:00`)) / 86_400_000)) : '');
const isoDay = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : value);

// The patient's part, common to every webhook. ctx: one entry of
// patientContexts().
export function patientFields(ctx) {
  const p = ctx.paciente;
  const h = ctx.historico;
  const last = h.ultimo_atendimento;
  const lastProcedures = (last?.procedimentos ?? []).join(', ');
  const done = h.procedimentos_realizados.map((x) => `${x.nome} (${x.vezes}x)`).join(', ');
  const next = ctx.agendamentos_futuros[0];
  const nextText = next ? `${brDay(next.data)} às ${next.inicio} · ${next.agenda.nome}` : '';
  // the three nearest returns
  const returns = [...ctx.retornos_pendentes].sort((a, b) => String(a.previsto_para).localeCompare(String(b.previsto_para))).slice(0, 3)
    .map((r) => `${r.procedimento} (previsto para ${brDay(r.previsto_para)})`).join(', ');

  const summary = [`${p.nome}${p.idade != null ? `, ${p.idade} anos` : ''}.`];
  if (last) {
    summary.push(`${h.total_atendimentos} visita(s); a última em ${brDay(last.data)} (${last.agenda.nome}${lastProcedures ? `: ${lastProcedures}` : ''}).`);
  } else {
    summary.push('Ainda não veio à clínica.');
  }
  if (done) summary.push(`Já fez: ${done}.`);
  if (returns) summary.push(`Retorno: ${returns}.`);
  summary.push(next ? `Próximo agendamento: ${nextText}.` : 'Nada agendado.');

  return {
    nome: p.nome ?? '',
    primeiro_nome: p.primeiro_nome ?? '',
    telefone: p.whatsapp ?? '',
    idade: p.idade ?? '',
    data_nascimento: brDay(p.data_nascimento),
    ultima_visita: brDay(last?.data),
    dias_desde_ultima_visita: daysSince(last?.data),
    ultima_visita_agenda: last?.agenda?.nome ?? '',
    ultima_visita_procedimentos: lastProcedures,
    total_visitas: h.total_atendimentos ?? 0,
    procedimentos_realizados: done,
    retornos_pendentes: returns,
    proximo_agendamento: nextText,
    resumo: summary.join(' '),
    paciente_id: p.id,
  };
}

// Disparos (campaigns).
export function campaignPayload({ campaign, recipientId, attempt = 1, ctx, test = false }) {
  const { paciente_id: patientId, data_nascimento: _birth, ...patient } = patientFields(ctx);
  return {
    tipo: 'campanha',
    teste: test,
    campanha: campaign.name ?? '',
    mensagem: campaign.message ?? '',
    envio_id: recipientId,
    tentativa: attempt,
    ...patient,
    paciente_id: patientId,
    campanha_id: campaign.id,
  };
}

// A return reminder that is due. r: { id, attempts, procedure, months,
// lastDay, daysSince, times, dueOn, notes, manual }.
export function reminderPayload({ r, ctx, test = false }) {
  const { paciente_id: patientId, ...patient } = patientFields(ctx);
  return {
    tipo: 'lembrete_retorno',
    teste: test,
    lembrete_id: r.id,
    tentativa: r.attempts ?? 1,
    procedimento: r.procedure ?? '',
    retorno_em_meses: r.months ?? '',
    data_ultima_vez: brDay(r.lastDay),
    dias_desde_ultima_vez: r.daysSince ?? '',
    vezes_que_fez: r.times ?? 0,
    data_retorno_prevista: brDay(isoDay(r.dueOn)),
    observacao: r.notes ?? '',
    criado_manualmente: Boolean(r.manual),
    ...patient,
    paciente_id: patientId,
  };
}

// Birthday, on the day. b: { id, attempts, birthDate, age }.
export function birthdayPayload({ b, ctx, test = false }) {
  const { paciente_id: patientId, ...patient } = patientFields(ctx);
  return {
    tipo: 'aniversario',
    teste: test,
    mensagem_id: b.id,
    tentativa: b.attempts ?? 1,
    ...patient,
    data_nascimento: brDay(isoDay(b.birthDate)),
    idade: b.age ?? patient.idade,
    paciente_id: patientId,
  };
}

// No-show. n: { id, attempts, minutesLate, appointment } where appointment
// comes from formatAppointment().
export function noShowPayload({ n, ctx, test = false }) {
  const { paciente_id: patientId, ...patient } = patientFields(ctx);
  const a = n.appointment ?? {};
  return {
    tipo: 'falta',
    teste: test,
    alerta_id: n.id,
    tentativa: n.attempts ?? 1,
    agendamento_data: brDay(a.data),
    agendamento_horario: a.inicio ?? '',
    agendamento_agenda: a.agenda?.nome ?? '',
    agendamento_tipo: a.tipo?.nome ?? '',
    agendamento_procedimentos: (a.procedimentos ?? []).join(', '),
    agendamento_status: a.status_descricao ?? '',
    minutos_desde_o_horario: n.minutesLate ?? '',
    ...patient,
    paciente_id: patientId,
    agendamento_id: a.id ?? '',
  };
}
