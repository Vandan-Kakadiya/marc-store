import { database } from './database.js';

const statusOf = (row) => row ? row.result ?? { pending: true, number: row.number } : null;

export function createOrderQueue(env, pool = database(env)) {
  if (!pool) return null;
  return {
    async enqueue(key, id, fingerprint, metadata, proof) {
      const { rows: [row] } = await pool.query(
        'SELECT * FROM marc.enqueue_order($1, $2, $3, $4, $5)',
        [key, id, fingerprint, metadata, proof]
      );
      if (row.disposition === 'different') return { ok: false, code: 'retry_different' };
      if (row.disposition === 'full') return { ok: false, code: 'queue_full' };
      return row.receipt ?? { pending: true, number: row.number };
    },
    async status(key) {
      const { rows: [row] } = await pool.query(
        'SELECT order_number AS number, result FROM marc.order_queue WHERE queue_key = $1', [key]
      );
      return statusOf(row);
    },
    async saveNumber(key, number) {
      await pool.query(`UPDATE marc.order_queue SET order_number = $2
        WHERE queue_key = $1 AND completed_at IS NULL AND order_number IS NULL`, [key, number]);
    },
    async list(cursor = '') {
      const { rows } = await pool.query(`SELECT queue_key FROM marc.order_queue
        WHERE completed_at IS NULL AND queue_key > $1 ORDER BY queue_key LIMIT 101`, [cursor]);
      const jobs = rows.slice(0, 100).map((row) => row.queue_key);
      return { jobs, ...(rows.length > 100 ? { cursor: jobs.at(-1) } : {}) };
    },
    async read(key) {
      const { rows: [row] } = await pool.query(
        'SELECT fingerprint, metadata, proof FROM marc.order_queue WHERE queue_key = $1 AND completed_at IS NULL',
        [key]
      );
      return row;
    },
    async complete(key, id, fingerprint, result) {
      const args = [key, id, fingerprint];
      const changed = await pool.query(`UPDATE marc.order_queue
        SET result = $4, completed_at = now(), metadata = NULL, proof = NULL
        WHERE queue_key = $1 AND order_id = $2 AND fingerprint = $3 AND completed_at IS NULL`,
        [...args, result]);
      if (changed.rowCount) return true;
      const saved = await pool.query(`SELECT 1 FROM marc.order_queue
        WHERE queue_key = $1 AND order_id = $2 AND fingerprint = $3 AND completed_at IS NOT NULL`, args);
      return !!saved.rowCount;
    },
    async availableBytes() {
      const { rows: [row] } = await pool.query(`UPDATE marc.queue_control SET checked_at = now()
        WHERE singleton RETURNING max_proof_bytes - (SELECT COALESCE(SUM(proof_bytes), 0)
          FROM marc.order_queue WHERE completed_at IS NULL) AS remaining`);
      if (!row) throw Error('Install database/schema.sql before enabling payments.');
      return Number(row.remaining);
    },
    async cleanExpired() {
      await pool.query(`WITH sweep AS (
        UPDATE marc.queue_control SET cleaned_at = now()
        WHERE singleton AND cleaned_at < now() - interval '1 hour' RETURNING singleton
      ), old_orders AS (
        DELETE FROM marc.order_queue WHERE completed_at < now() - interval '30 days' AND EXISTS (SELECT 1 FROM sweep)
      )
      DELETE FROM marc.account_state WHERE expires_at <= now() AND EXISTS (SELECT 1 FROM sweep)`);
    }
  };
}
