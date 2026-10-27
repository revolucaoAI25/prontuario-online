import pg from 'pg';

// Dates come back as 'YYYY-MM-DD' strings instead of JS Dates at local midnight.
pg.types.setTypeParser(1082, (value) => value);

let pool;

export function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }
    const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString);
    pool = new pg.Pool({
      connectionString,
      // Serverless: keep few connections per instance; use Supabase's
      // transaction pooler (port 6543) in production.
      max: Number(process.env.DATABASE_POOL_MAX || 3),
      ssl: isLocal ? false : { rejectUnauthorized: false },
    });
  }
  return pool;
}

export async function query(sql, params = []) {
  return getPool().query(sql, params);
}

export async function queryOne(sql, params = []) {
  const { rows } = await query(sql, params);
  return rows[0] ?? null;
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
