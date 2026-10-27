// Development/test stand-in for a Supabase project's HTTP surface:
//   /rest/v1     → proxied to a local PostgREST (same engine Supabase uses)
//   /auth/v1     → email/password sessions, user lookup, admin user creation
//   /storage/v1  → uploads and signed URLs kept on disk
// Realtime is not emulated; the app falls back to polling.
// Never deploy this: production uses a real Supabase project.
import http from 'node:http';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

export const DEV_JWT_SECRET = 'dev-only-jwt-secret-with-at-least-32-characters';

const b64url = (value) => Buffer.from(value).toString('base64url');

export function signJwt(payload, secret = DEV_JWT_SECRET) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

export function verifyJwt(token, secret = DEV_JWT_SECRET) {
  const [head, body, sig] = String(token ?? '').split('.');
  if (!sig) return null;
  const expected = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  if (expected !== sig) return null;
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (payload.exp && payload.exp < Date.now() / 1000) return null;
  return payload;
}

const FAR_FUTURE = 4_102_444_800; // 2100-01-01
export const ANON_KEY = signJwt({ iss: 'supabase-dev', role: 'anon', exp: FAR_FUTURE });
export const SERVICE_ROLE_KEY = signJwt({ iss: 'supabase-dev', role: 'service_role', exp: FAR_FUTURE });

function userObject(row) {
  return {
    id: row.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: row.email,
    email_confirmed_at: row.created_at,
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: row.raw_user_meta_data ?? {},
    created_at: row.created_at,
    updated_at: row.created_at,
  };
}

export function createEmulator({ databaseUrl, postgrestUrl, storageDir }) {
  const db = new pg.Pool({ connectionString: databaseUrl, max: 3 });
  const refreshTokens = new Map();

  function session(user) {
    const now = Math.floor(Date.now() / 1000);
    const accessToken = signJwt({
      sub: user.id, email: user.email, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 3600,
    });
    const refreshToken = randomBytes(24).toString('hex');
    refreshTokens.set(refreshToken, user.id);
    return {
      access_token: accessToken, token_type: 'bearer', expires_in: 3600, expires_at: now + 3600,
      refresh_token: refreshToken, user: userObject(user),
    };
  }

  const send = (res, status, body) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const authError = (res, status, msg, code = 'invalid_credentials') =>
    send(res, status, { code: status, error_code: code, msg });

  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Buffer.concat(chunks);
  }

  function claimsOf(req) {
    const auth = req.headers.authorization || '';
    const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : req.headers.apikey;
    return verifyJwt(token);
  }

  async function handleAuth(req, res, url) {
    const route = url.pathname.replace('/auth/v1', '');
    if (route === '/token' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const grant = url.searchParams.get('grant_type');
      if (grant === 'password') {
        const { rows } = await db.query(
          `select * from auth.users where lower(email) = lower($1)
           and encrypted_password = extensions.crypt($2, encrypted_password)`,
          [body.email, body.password ?? ''],
        );
        if (!rows[0]) return authError(res, 400, 'Invalid login credentials');
        return send(res, 200, session(rows[0]));
      }
      if (grant === 'refresh_token') {
        const userId = refreshTokens.get(body.refresh_token);
        if (!userId) return authError(res, 400, 'Invalid Refresh Token', 'refresh_token_not_found');
        refreshTokens.delete(body.refresh_token);
        const { rows } = await db.query(`select * from auth.users where id = $1`, [userId]);
        return send(res, 200, session(rows[0]));
      }
      return authError(res, 400, 'unsupported grant');
    }
    const claims = claimsOf(req);
    if (route === '/user' && req.method === 'GET') {
      if (!claims?.sub) return authError(res, 401, 'invalid JWT', 'bad_jwt');
      const { rows } = await db.query(`select * from auth.users where id = $1`, [claims.sub]);
      return rows[0] ? send(res, 200, userObject(rows[0])) : authError(res, 404, 'User not found', 'user_not_found');
    }
    if (route === '/logout') return send(res, 204);
    if (route.startsWith('/admin/users')) {
      if (claims?.role !== 'service_role') return authError(res, 403, 'service role required', 'not_admin');
      const id = route.split('/')[3];
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : JSON.parse((await readBody(req)).toString() || '{}');
      if (req.method === 'POST' && !id) {
        try {
          const { rows } = await db.query(
            `insert into auth.users (id, email, encrypted_password, raw_user_meta_data)
             values ($1, $2, extensions.crypt($3, extensions.gen_salt('bf')), $4) returning *`,
            [randomUUID(), body.email, body.password ?? randomBytes(12).toString('hex'), body.user_metadata ?? {}],
          );
          return send(res, 200, userObject(rows[0]));
        } catch (error) {
          if (error.code === '23505') return authError(res, 422, 'A user with this email address has already been registered', 'email_exists');
          throw error;
        }
      }
      if (req.method === 'PUT' && id) {
        if (body.password) {
          await db.query(`update auth.users set encrypted_password = extensions.crypt($2, extensions.gen_salt('bf')) where id = $1`, [id, body.password]);
        }
        if (body.email) await db.query(`update auth.users set email = $2 where id = $1`, [id, body.email]);
        const { rows } = await db.query(`select * from auth.users where id = $1`, [id]);
        return send(res, 200, userObject(rows[0]));
      }
      if (req.method === 'DELETE' && id) {
        await db.query(`delete from auth.users where id = $1`, [id]);
        return send(res, 200, {});
      }
      if (req.method === 'GET') {
        const { rows } = await db.query(`select * from auth.users order by created_at`);
        return send(res, 200, { users: rows.map(userObject), aud: 'authenticated' });
      }
    }
    return authError(res, 404, 'not found', 'not_found');
  }

  async function handleRest(req, res, url) {
    const target = new URL(url.pathname.replace('/rest/v1', '') + url.search, postgrestUrl);
    const headers = {};
    for (const h of ['content-type', 'prefer', 'accept', 'range', 'range-unit', 'accept-profile', 'content-profile']) {
      if (req.headers[h]) headers[h] = req.headers[h];
    }
    headers.authorization = req.headers.authorization || `Bearer ${req.headers.apikey ?? ANON_KEY}`;
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
    const upstream = await fetch(target, { method: req.method, headers, body });
    res.statusCode = upstream.status;
    for (const [k, v] of upstream.headers) {
      if (['content-type', 'content-range', 'preference-applied', 'location'].includes(k)) res.setHeader(k, v);
    }
    res.end(Buffer.from(await upstream.arrayBuffer()));
  }

  async function handleStorage(req, res, url) {
    const route = decodeURIComponent(url.pathname.replace('/storage/v1', ''));
    const signed = route.match(/^\/object\/sign\/([^/]+)\/(.+)$/);
    if (signed && req.method === 'GET') {
      const claims = verifyJwt(url.searchParams.get('token'));
      if (!claims || claims.url !== `${signed[1]}/${signed[2]}`) return send(res, 400, { message: 'invalid token' });
      const file = path.join(storageDir, signed[1], signed[2]);
      if (!existsSync(file)) return send(res, 404, { message: 'not found' });
      return res.end(readFileSync(file));
    }
    const claims = claimsOf(req);
    if (!claims || !['authenticated', 'service_role'].includes(claims.role)) return send(res, 401, { message: 'unauthorized' });
    if (signed && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const token = signJwt({ url: `${signed[1]}/${signed[2]}`, exp: Math.floor(Date.now() / 1000) + (body.expiresIn ?? 60) });
      return send(res, 200, { signedURL: `/object/sign/${signed[1]}/${signed[2]}?token=${token}` });
    }
    const object = route.match(/^\/object\/([^/]+)\/(.+)$/);
    if (object && (req.method === 'POST' || req.method === 'PUT')) {
      const file = path.join(storageDir, object[1], object[2]);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, await readBody(req));
      return send(res, 200, { Key: `${object[1]}/${object[2]}` });
    }
    const bucket = route.match(/^\/object\/([^/]+)$/);
    if (bucket && req.method === 'DELETE') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      for (const prefix of body.prefixes ?? []) rmSync(path.join(storageDir, bucket[1], prefix), { force: true });
      return send(res, 200, []);
    }
    return send(res, 404, { message: 'not found' });
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, apikey, x-client-info, content-type, prefer, range, accept-profile, content-profile, x-upsert, x-supabase-api-version');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'content-range, content-type');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      return res.end();
    }
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/auth/v1')) return await handleAuth(req, res, url);
      if (url.pathname.startsWith('/rest/v1')) return await handleRest(req, res, url);
      if (url.pathname.startsWith('/storage/v1')) return await handleStorage(req, res, url);
      send(res, 404, { message: 'not emulated' });
    } catch (error) {
      console.error(error);
      send(res, 500, { message: error.message });
    }
  });
  server.on('close', () => db.end());
  return server;
}
