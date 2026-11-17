import { ApiError } from './http.js';
import { campaignTimeoutMs, postWebhook } from './dispatch.js';
import { whatsappNumber } from './patient-context.js';
import { birthdayPayload, campaignPayload, noShowPayload, reminderPayload } from './webhook-payloads.js';

// "Enviar teste" (Disparos and Ajustes → Integrações): posts to a webhook the
// same JSON a real send carries, built by the same function, with a made-up
// patient and "teste": true, and reports what came back. An optional phone
// (yours) replaces the made-up one, to see the message arrive end to end.
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const ZERO = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

function sampleContext(telefone) {
  const visit = (data, procedimentos) => ({ agenda: { nome: 'Estética' }, data, inicio: '14:00', procedimentos });
  return {
    paciente: {
      id: ZERO('c1'),
      nome: 'Paciente Teste da Silva',
      primeiro_nome: 'Paciente',
      whatsapp: whatsappNumber(telefone) ?? '5531900000000',
      idade: 36,
      data_nascimento: '1990-05-20',
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

const SAMPLES = {
  campanha: (ctx, body) => campaignPayload({
    campaign: { id: ZERO(0), name: body.nome || 'Campanha de teste', message: body.mensagem || null },
    recipientId: ZERO('f1'), ctx, test: true,
  }),
  lembrete: (ctx) => reminderPayload({
    ctx, test: true,
    r: { id: ZERO('d1'), procedure: 'Botox', months: 4, lastDay: daysAgo(150), daysSince: 150, times: 2, dueOn: daysAgo(30), notes: null, manual: false },
  }),
  aniversario: (ctx) => birthdayPayload({
    ctx, test: true,
    b: { id: ZERO('e1'), birthDate: `1990-${new Date().toISOString().slice(5, 10)}`, age: new Date().getFullYear() - 1990 },
  }),
  falta: (ctx) => noShowPayload({
    ctx, test: true,
    n: {
      id: ZERO('a1'),
      minutesLate: 125,
      appointment: {
        id: ZERO('b1'), agenda: { nome: 'Dr. Everson Rezeck' }, tipo: { nome: 'Consulta' }, data: new Date().toISOString().slice(0, 10),
        inicio: '09:00', procedimentos: ['Botox'], status_descricao: 'Confirmado pelo paciente',
      },
    },
  }),
};

// POST /api/admin/testar_webhook { tipo, url, telefone?, nome?, mensagem? }
export async function testWebhook(body, _req, staff) {
  if (!staff.is_superadmin) throw new ApiError(403, 'acesso_negado', 'Apenas o super admin testa webhooks.');
  const build = SAMPLES[body.tipo ?? 'campanha'];
  if (!build) throw new ApiError(400, 'campo_invalido', 'Tipo de webhook desconhecido.', { campo: 'tipo' });
  const url = String(body.url ?? '').trim();
  if (!/^https?:\/\/[^\s]+$/.test(url)) throw new ApiError(400, 'campo_invalido', 'Informe o endereço do webhook (https://...).', { campo: 'url' });
  if (body.telefone && !whatsappNumber(body.telefone)) {
    throw new ApiError(400, 'campo_invalido', 'Telefone inválido para WhatsApp.', { campo: 'telefone' });
  }
  const payload = build(sampleContext(body.telefone), body);
  // campaigns wait up to 30 s; the daily webhooks 10 s, as in a real send
  const timeoutMs = body.tipo && body.tipo !== 'campanha' ? 10_000 : campaignTimeoutMs();
  try {
    const r = await postWebhook(url, payload, { timeoutMs });
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

// Kept for the Disparos screen already deployed.
export const testCampaignWebhook = (body, req, staff) => testWebhook({ ...body, tipo: 'campanha' }, req, staff);
