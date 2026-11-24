import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createOrderQueue } from './queue-store.js';
import { fail, json, orderPattern, proofLimit, readJSON, sha256Pattern, siteURL } from './common.js';

const conflicts = ['reference_in_use', 'retry_different'];
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };

export function queueKey(env, quote) {
  return createHmac('sha256', env.MARC_SCRIPT_SECRET)
    .update(JSON.stringify(['MARC queued order', quote.id, quote.buyer, quote.collection || '']))
    .digest('hex');
}

export function orderFingerprint(metadata, bytes) {
  return createHash('sha256').update(metadata).update('\n').update(bytes).digest('hex');
}

export function enqueueOrder(queue, key, order, bytes, metadata = JSON.stringify(order)) {
  return queue.enqueue(key, order.id, orderFingerprint(metadata, bytes), metadata, bytes);
}

export function queueReadiness(queue) {
  let check, nextCheckAt = 0;
  return {
    ready() {
      if (Date.now() >= nextCheckAt) {
        nextCheckAt = Date.now() + 15000;
        check = queue.availableBytes().then((bytes) => bytes >= proofLimit, () => false);
      }
      return check;
    },
    pause() {
      // Recheck after a short outage without blocking any older payment quote.
      nextCheckAt = Date.now() + 15000;
      check = Promise.resolve(false);
    }
  };
}

function workerRequest(body, secret) {
  if (!sha256Pattern.test(secret || '') || !Number.isSafeInteger(body.issuedAt) ||
      Math.abs(Date.now() - body.issuedAt) > 5 * 60000 ||
      !sha256Pattern.test(body.signature || '') || typeof body.payload !== 'string') return null;
  const expected = createHmac('sha256', secret)
    .update('MARC order queue\n' + body.issuedAt + '\n' + body.payload).digest();
  if (!timingSafeEqual(expected, Buffer.from(body.signature, 'hex'))) return null;
  return JSON.parse(body.payload);
}

function queueReceipt(id, result, reviewArchived) {
  if (result?.ok === true && result.data?.id === id &&
      result.data.status === 'under_review' && Number.isFinite(Date.parse(result.data.submittedAt))) {
    const { number, submittedAt, status } = result.data;
    return { ok: true, data: { id, number, submittedAt, status } };
  }
  if (reviewArchived === true && result?.ok === false && conflicts.includes(result.code))
    return { ok: false, code: result.code };
  fail(400, 'Invalid order status.');
}

export function createQueueWorker({ env, queue = createOrderQueue(env) }) {
  return async (req) => {
    try {
      if (req.method !== 'POST' || new URL(req.url).origin !== siteURL(env.MARC_SITE_URL))
        return json({ ok: false }, 404);
      const request = workerRequest(await readJSON(req, 8000), env.MARC_SCRIPT_SECRET);
      if (!request) return json({ ok: false }, 403);
      if (!queue) return json({ ok: false }, 503);
      const { action, key, cursor } = request;
      if (action === 'check') {
        await queue.availableBytes();
        return json({ ok: true });
      }
      if (action === 'list') {
        if (cursor !== undefined && !sha256Pattern.test(cursor))
          return json({ ok: false }, 400);
        if (!cursor) await queue.cleanExpired();
        return json(await queue.list(cursor));
      }
      if (!['read', 'finish'].includes(action) || typeof key !== 'string' || !sha256Pattern.test(key))
        return json({ ok: false }, 400);
      if (action === 'read') {
        const job = await queue.read(key);
        if (!job) return new Response(null, { status: 204, headers });
        const body = Buffer.concat([Buffer.from(job.fingerprint + '\n' + job.metadata + '\n'), job.proof]);
        return new Response(body, { headers: { ...headers, 'Content-Type': 'application/octet-stream' } });
      }

      const { id, fingerprint, result, reviewArchived } = request;
      if (!orderPattern.test(id || '') || !sha256Pattern.test(fingerprint || ''))
        return json({ ok: false }, 400);
      const receipt = queueReceipt(id, result, reviewArchived);
      if (!await queue.complete(key, id, fingerprint, receipt))
        return json({ ok: false }, 409);
      return new Response(null, { status: 204, headers });
    } catch (error) {
      return json({ ok: false }, error.status === 400 ? 400 : 503);
    }
  };
}
