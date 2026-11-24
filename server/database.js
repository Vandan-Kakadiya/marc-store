import pg from 'pg';

const databases = new Map();

export function database(env) {
  const address = env.DATABASE_URL;
  if (!address) return null;
  if (databases.has(address)) return databases.get(address);

  const url = new URL(address);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname)
    throw Error('Set DATABASE_URL to the PostgreSQL connection string.');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!loopback || env.VERCEL) url.searchParams.set('sslmode', 'verify-full');
  const pool = new pg.Pool({
    connectionString: url.href,
    max: 4,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000
  });
  pool.on('error', () => console.warn('MARC database connection closed.'));
  databases.set(address, pool);
  return pool;
}
