import { createHmac, randomUUID } from 'node:crypto';
import { database } from './database.js';
import { callScript } from './script-client.js';

export const sessionSeconds = 60 * 60;

export function accountKey(env, buyer) {
  return createHmac('sha256', env.MARC_SESSION_KEY)
    .update('MARC account state\n' + buyer.sub)
    .digest('hex');
}

export function createAccountStore(env, fetcher = fetch, pool = database(env)) {
  if (!pool) {
    async function request(action, kind, key, details) {
      const result = await callScript(env, 'accountState', { action, kind, key, ...details }, fetcher, 9000);
      if (result.ok) return result.data;
      if (result.code === 'conflict') return false;
      throw Error('Account storage is temporarily unavailable.');
    }
    return {
      read: (kind, key) => request('read', kind, key),
      write: (kind, key, value, expected) => request('write', kind, key, { value, expected }),
      remove: (kind, key, expected) => request('remove', kind, key, { expected })
    };
  }

  const retention = { session: sessionSeconds, bag: 30 * 86400 };
  return {
    async read(kind, key) {
      const { rows: [row] } = await pool.query(`SELECT version, value FROM marc.account_state
        WHERE kind = $1 AND owner = $2 AND expires_at > now()`, [kind, key]);
      return row ?? null;
    },
    async write(kind, key, value, expected) {
      const version = randomUUID();
      const args = [kind, key, version, value, retention[kind]];
      const query = typeof expected === 'string'
        ? `UPDATE marc.account_state SET version = $3, value = $4,
            expires_at = now() + $5 * interval '1 second'
            WHERE kind = $1 AND owner = $2 AND version::text = $6 AND expires_at > now()`
        : `INSERT INTO marc.account_state (kind, owner, version, value, expires_at)
            VALUES ($1, $2, $3, $4, now() + $5 * interval '1 second')
            ON CONFLICT (kind, owner) DO UPDATE SET
              version = EXCLUDED.version, value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
            WHERE $6::boolean OR marc.account_state.expires_at <= now()`;
      const stored = await pool.query(query, [...args, typeof expected === 'string' ? expected : expected === undefined]);
      return stored.rowCount ? { version, value } : false;
    },
    async remove(kind, key, expected) {
      const removed = await pool.query(
        'DELETE FROM marc.account_state WHERE kind = $1 AND owner = $2 AND version::text = $3',
        [kind, key, expected]
      );
      return !!removed.rowCount;
    }
  };
}
