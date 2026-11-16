import { ApiError } from './http.js';
import { campaignTimeoutMs, postWebhook } from './dispatch.js';
import { whatsappNumber } from './patient-context.js';

// "Enviar teste" (Disparos): posts to a campaign's webhook the same JSON a
// real send carries, with a made-up patient and "teste": true, and reports
// what came back. An optional phone (yours) replaces the made-up one, to see
// the message arrive end to end.
function samplePayload({ nome, mensagem, telefone }) {
  const today = new Date().toISOString().slice(0, 10);
  const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const whatsapp = whatsappNumber(telefone) ?? '5531900000000';
  const local = whatsapp.replace(/^55/, '');
  const visit = (id, data, procedimentos) => ({
    id: `00000000-0000-0000-0000-00000000000${id}`,
    agenda: { id: '00000000-0000-0000-0000-0000000000a1', nome: 'Estética' },
    tipo: { id: '00000000-0000-0000-0000-0000000000b1', nome: 'Consulta' },
    data, inicio: '14:00', fim: '15:00', duracao_minutos: 60,
    status: 'chegou', status_descricao: 'Paciente chegou', procedimentos, observacao: null, motivo_cancelamento: null,
  });
  return {
    tipo: 'campanha',
    teste: true,
    campanha: { id: '00000000-0000-0000-0000-000000000000', nome: nome || 'Campanha de teste', mensagem: mensagem || null },
    envio_id: '00000000-0000-0000-0000-0000000000f1',
    tentativa: 1,
    paciente: {
      id: '00000000-0000-0000-0000-0000000000c1',
      nome: 'Paciente Teste da Silva',
      primeiro_nome: 'Paciente',
      telefone: `(${local.slice(0, 2)}) ${local.slice(2, -4)}-${local.slice(-4)}`,
      telefone_2: null,
      whatsapp,
      email: null,
      data_nascimento: '1990-05-20',
      idade: 36,
      aceita_mensagens: true,
    },
    agendamentos_futuros: [],
    retornos_pendentes: [{ procedimento: 'Botox', ultima_vez: daysAgo(150), previsto_para: daysAgo(30) }],
    historico: {
      total_atendimentos: 3,
      primeiro_atendimento: daysAgo(400),
      ultimo_atendimento: visit(1, daysAgo(150), ['Botox']),
      faltas: 0,
      cancelamentos: 0,
      procedimentos_realizados: [{ nome: 'Botox', vezes: 2, ultima_vez: daysAgo(150) }, { nome: 'Limpeza de pele', vezes: 1, ultima_vez: daysAgo(400) }],
      agendas: [{ nome: 'Estética', atendimentos: 3 }],
      ultimos_agendamentos: [visit(1, daysAgo(150), ['Botox']), visit(2, daysAgo(400), ['Limpeza de pele'])],
      prontuario: { anotacoes: 3, ultima_anotacao: daysAgo(150) },
    },
    resumo: `Paciente Teste da Silva, 36 anos. 3 atendimentos, o último em ${daysAgo(150)} (Botox). Retorno de Botox previsto para ${daysAgo(30)}. Nada agendado. (Mensagem de teste gerada em ${today}.)`,
  };
}

// POST /api/admin/testar_webhook_campanha { url, nome?, mensagem?, telefone? }
export async function testCampaignWebhook(body, _req, staff) {
  if (!staff.is_superadmin) throw new ApiError(403, 'acesso_negado', 'Apenas o super admin testa disparos.');
  const url = String(body.url ?? '').trim();
  if (!/^https?:\/\/[^\s]+$/.test(url)) throw new ApiError(400, 'campo_invalido', 'Informe o endereço do webhook (https://...).', { campo: 'url' });
  if (body.telefone && !whatsappNumber(body.telefone)) {
    throw new ApiError(400, 'campo_invalido', 'Telefone inválido para WhatsApp.', { campo: 'telefone' });
  }
  const payload = samplePayload({ nome: body.nome, mensagem: body.mensagem, telefone: body.telefone });
  try {
    const r = await postWebhook(url, payload, { timeoutMs: campaignTimeoutMs() });
    return { recebido: true, status_http: r.status, tempo_ms: r.ms, resposta: r.body, enviado: payload };
  } catch (error) {
    return {
      recebido: false,
      erro: error.message,
      incerto: Boolean(error.uncertain),
      status_http: error.status ?? null,
      tempo_ms: error.ms ?? null,
      resposta: error.body ?? null,
      enviado: payload,
    };
  }
}
