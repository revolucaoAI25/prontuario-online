// A minimal stand-in for pg.Client that sends SQL over HTTPS to the Supabase
// Management API, for machines that can only reach the internet on port 443.
// Parameters are inlined as SQL literals (dollar-quoted strings), and
// begin/commit/rollback are no-ops: every statement runs on its own, so the
// callers must be idempotent (the FastClinic import is: it upserts by
// legacy_id).

function dollarQuote(text) {
  let n = 0;
  while (text.includes(`$q${n}$`)) n++;
  return `$q${n}$${text}$q${n}$`;
}

function arrayLiteral(items) {
  const inner = items.map((v) => {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return String(v);
    return `"${String(v).replace(/[\\"]/g, '\\$&')}"`;
  });
  return dollarQuote(`{${inner.join(',')}}`);
}

export function literal(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`número inválido: ${value}`);
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return dollarQuote(value.toISOString());
  if (Array.isArray(value)) return arrayLiteral(value);
  if (typeof value === 'object') return dollarQuote(JSON.stringify(value));
  return dollarQuote(String(value));
}

export function inlineParams(text, params = []) {
  return text.replace(/\$(\d+)(?!\d)/g, (match, index) => {
    const i = Number(index) - 1;
    if (i < 0 || i >= params.length) throw new Error(`parâmetro ${match} sem valor`);
    return literal(params[i]);
  });
}

export class SqlClient {
  constructor(run) {
    this.run = run;
  }

  async connect() {}

  async end() {}

  async query(text, params = []) {
    if (/^\s*(begin|commit|rollback)\s*;?\s*$/i.test(text)) return { rows: [], rowCount: 0 };
    const rows = await this.run(inlineParams(text, params));
    return { rows, rowCount: rows.length };
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// POST /v1/projects/{ref}/database/query with a personal access token.
export function managementApiRunner({ token, projectRef, attempts = 5 }) {
  return async (sql) => {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query: sql }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok) return Array.isArray(body) ? body : body?.result ?? [];
      const retry = res.status === 429 || res.status >= 500;
      if (!retry || attempt >= attempts) {
        throw new Error(`Supabase respondeu ${res.status}: ${body?.message ?? body?.error ?? JSON.stringify(body)}`);
      }
      await sleep(1000 * 2 ** (attempt - 1));
    }
  };
}
