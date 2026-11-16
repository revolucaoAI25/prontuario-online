import { ApiError } from './http.js';
import { campaignTimeoutMs, postWebhook } from './dispatch.js';
import { whatsappNumber } from './patient-context.js';
import { campaignPayload } from './campaign-payload.js';

// "Enviar teste" (Disparos): posts to a campaign's webhook the same JSON a
// real send carries, with a made-up patient and "teste": true, and reports
// what came back. An optional phone (yours) replaces the made-up one, to see
// the message arrive end to end.
// A made-up patient in the same shape patientContexts() gives, so the test
// goes through the same builder as a real send.
function sampleContext(telefone) {
  const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const visit = (data, procedimentos) => ({ agenda: { nome: 'Estética' }, data, inicio: '14:00', procedimentos });
  return {
    paciente: {
      id: '00000000-0000-0000-0000-0000000000c1',
      nome: 'Paciente Teste da Silva',
      primeiro_nome: 'Paciente',
      whatsapp: whatsappNumber(telefone) ?? '5531900000000',
      idade: 36,
    },
    historico: {
      total_atendimentos: 3,
      ultimo_atendimento: visit(daysAgo(150), ['Botox']),
      procedimentos_realizados: [{ nome: 'Botox', vezes: 2 }, { nome: 'Limpeza de pele', vezes: 1 }],
    },
    agendamentos_futuros: [],
    retornos_pendentes: [{ procedimento: 'Botox', previsto_para: daysAgo(30) }],
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
  const payload = campaignPayload({
    campaign: { id: '00000000-0000-0000-0000-000000000000', name: body.nome || 'Campanha de teste', message: body.mensagem || null },
    recipientId: '00000000-0000-0000-0000-0000000000f1',
    ctx: sampleContext(body.telefone),
    test: true,
  });
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
