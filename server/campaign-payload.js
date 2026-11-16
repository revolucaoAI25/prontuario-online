// What a campaign webhook receives for each patient: one flat level of plain
// fields (text or number), so tools like Chatflux can pick each one as a
// variable. Dates are dd/mm/aaaa; a missing piece is an empty text.

const brDay = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '');
const daysSince = (iso) => (iso ? Math.max(0, Math.round((Date.now() - new Date(`${String(iso).slice(0, 10)}T12:00:00-03:00`)) / 86_400_000)) : '');

// ctx: one entry of patientContexts().
export function campaignPayload({ campaign, recipientId, attempt = 1, ctx, test = false }) {
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
    tipo: 'campanha',
    teste: test,
    campanha: campaign.name ?? '',
    mensagem: campaign.message ?? '',
    envio_id: recipientId,
    tentativa: attempt,
    nome: p.nome ?? '',
    primeiro_nome: p.primeiro_nome ?? '',
    telefone: p.whatsapp ?? '',
    idade: p.idade ?? '',
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
    campanha_id: campaign.id,
  };
}
