import { timingSafeEqual } from 'node:crypto';

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// Stable codes raised by the database functions.
const DB_ERRORS = {
  agenda_nao_encontrada: [404, 'Agenda não encontrada.'],
  paciente_nao_encontrado: [404, 'Paciente não encontrado.'],
  agendamento_nao_encontrado: [404, 'Agendamento não encontrado.'],
  tipo_invalido_para_agenda: [400, 'Esse tipo de atendimento não pertence a essa agenda.'],
  horario_invalido: [400, 'O horário de término precisa ser depois do início.'],
  horario_no_passado: [400, 'Não é possível agendar em um horário que já passou.'],
  fora_do_horario_de_atendimento: [409, 'Fora do horário de atendimento dessa agenda.'],
  horario_indisponivel: [409, 'Esse horário não está disponível.'],
  agendamento_cancelado: [409, 'Esse agendamento está cancelado.'],
  agendamento_ja_realizado: [409, 'Esse atendimento já foi realizado.'],
};

function translateError(error) {
  if (error instanceof ApiError) return error;
  const known = DB_ERRORS[error?.message];
  if (known) return new ApiError(known[0], error.message, known[1]);
  if (error?.code === '22P02' || error?.code === '22007' || error?.code === '22008') {
    return new ApiError(400, 'dado_invalido', 'Algum campo enviado tem formato inválido.');
  }
  return null;
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function keyMatches(given, expected) {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function apiKeyFrom(req) {
  const header = req.headers['x-api-key'];
  if (header) return String(header);
  const auth = req.headers.authorization || '';
  return auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null;
}

async function readBody(req) {
  if (req.body !== undefined) {
    if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
    if (Buffer.isBuffer(req.body)) return req.body.length ? JSON.parse(req.body.toString('utf8')) : {};
    return req.body ?? {};
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

// Wraps a Vercel-style handler: CORS, API key, JSON body, error translation.
// `routes` maps the dynamic path segment to a function(body, req) => result.
export function apiRouter(routes, { param = 'acao', keyEnv = 'CLINIC_API_KEY' } = {}) {
  return async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-api-key, authorization');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      return res.end();
    }

    try {
      if (!keyMatches(apiKeyFrom(req), process.env[keyEnv])) {
        throw new ApiError(401, 'nao_autorizado', 'Chave de API ausente ou inválida.');
      }
      if (req.method !== 'POST') {
        throw new ApiError(405, 'metodo_nao_permitido', 'Use POST com um corpo JSON.');
      }
      const action = req.query?.[param];
      const route = routes[action];
      if (!route) {
        throw new ApiError(404, 'rota_nao_encontrada', `Ação desconhecida: ${action}. Disponíveis: ${Object.keys(routes).join(', ')}.`);
      }
      let body;
      try {
        body = await readBody(req);
      } catch {
        throw new ApiError(400, 'json_invalido', 'O corpo da requisição não é um JSON válido.');
      }
      const result = await route(body ?? {}, req);
      send(res, 200, { ok: true, ...result });
    } catch (error) {
      const apiError = translateError(error);
      if (!apiError) {
        console.error(error);
        return send(res, 500, { ok: false, erro: { codigo: 'erro_interno', mensagem: 'Erro interno. Tente novamente.' } });
      }
      send(res, apiError.status, {
        ok: false,
        erro: { codigo: apiError.code, mensagem: apiError.message, ...(apiError.details ? { detalhes: apiError.details } : {}) },
      });
    }
  };
}
