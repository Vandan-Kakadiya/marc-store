import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import * as blob from '@vercel/blob';
import { fail, json, orderPattern, readJSON, sha256Pattern, siteURL } from './common.js';

const root = 'marc/orders/v1/';
const pendingPath = (key) => `${root}pending/${key}.bin`;
const resultPath = (key) => `${root}results/${key}.json`;
const numberPath = (key) => `${root}numbers/${key}.txt`;
const conflicts = ['reference_in_use', 'retry_different'];
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };

export function queueStore(env, sdk = blob) {
  const options = (timeout = 12000) => ({
    token: env.BLOB_READ_WRITE_TOKEN,
    abortSignal: AbortSignal.timeout(timeout)
  });
  return {
    async get(path) {
      const object = await sdk.get(path, { ...options(), access: 'private', useCache: false });
      return object?.stream ?? null;
    },
    async has(path, timeout) {
      try {
        return !!(await sdk.head(path, options(timeout)));
      } catch (e) {
        if (e instanceof blob.BlobNotFoundError) return false;
        throw e;
      }
    },
    put(path, body, contentType, ttlDays, timeout) {
      return sdk.put(path, body, {
        ...options(timeout), access: 'private', addRandomSuffix: false,
        allowOverwrite: false, contentType, ...(ttlDays ? { ttlDays } : {})
      });
    },
    remove(path) {
      return sdk.del(path, options());
    },
    async list(prefix, cursor) {
      const page = await sdk.list({ ...options(), prefix, cursor, limit: 100 });
      return { paths: page.blobs.map((item) => item.pathname), cursor: page.hasMore ? page.cursor : undefined };
    }
  };
}

export function queueReadiness(store) {
  const windowMs = 5 * 60000;
  let recent, pausedUntil = 0;

  async function check(slot) {
    const marker = `${root}checks/payment-${slot}.txt`;
    if (await store.has(marker, 2200)) return true;
    try {
      await store.put(marker, 'ready', 'text/plain', 1, 2200);
      return true;
    } catch {
      // A concurrent checkout may already have written the shared marker.
      return store.has(marker, 2200);
    }
  }

  return {
    async ready() {
      const now = Date.now(), slot = Math.floor(now / windowMs);
      if (now < pausedUntil) return false;
      if (!recent || recent.slot !== slot || now >= recent.until) {
        const next = { slot, until: (slot + 1) * windowMs };
        next.result = check(slot).catch(() => false).then((available) => {
          if (!available) next.until = Date.now() + 15000;
          return available;
        });
        recent = next;
      }
      return await recent.result && Date.now() >= pausedUntil;
    },
    pause() {
      pausedUntil = (Math.floor(Date.now() / windowMs) + 1) * windowMs;
    }
  };
}

export function queueKey(env, quote) {
  return createHmac('sha256', env.MARC_SCRIPT_SECRET)
    .update(JSON.stringify(['MARC queued order', quote.id, quote.buyer, quote.collection || '']))
    .digest('hex');
}

async function readResult(store, key) {
  const stream = await store.get(resultPath(key));
  return stream ? new Response(stream).json() : null;
}

export async function queuedNumber(store, key) {
  const stream = await store.get(numberPath(key));
  return stream ? new Response(stream).text() : '';
}

export function rememberQueuedNumber(store, key, number) {
  return store.put(numberPath(key), number, 'text/plain', 8);
}

export async function queuedStatus(store, key) {
  const result = await readResult(store, key);
  if (result) return result;
  if (await store.has(pendingPath(key))) return { pending: true, number: await queuedNumber(store, key) };
  // Completion writes the result before removing the pending file.
  return await readResult(store, key);
}

async function queuedFingerprint(store, key) {
  const stream = await store.get(pendingPath(key));
  if (!stream) return '';
  const reader = stream.getReader();
  const fingerprint = Buffer.alloc(65);
  let offset = 0;
  try {
    while (offset < fingerprint.length) {
      const { done, value } = await reader.read();
      if (done) throw Error('Incomplete queued submission.');
      const length = Math.min(fingerprint.length - offset, value.length);
      fingerprint.set(value.subarray(0, length), offset);
      offset += length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (fingerprint[64] !== 10 || !sha256Pattern.test(fingerprint.toString('ascii', 0, 64)))
    throw Error('Invalid queued submission.');
  return fingerprint.toString('ascii', 0, 64);
}

export async function enqueueOrder(store, key, order, bytes) {
  const metadata = Buffer.from(JSON.stringify(order));
  const fingerprint = createHash('sha256').update(metadata).update('\n').update(bytes).digest('hex');
  const existing = (result, previous) => previous === fingerprint
    ? result ?? { pending: true }
    : { ok: false, code: 'retry_different' };
  const result = await readResult(store, key);
  if (result) return existing(result, result.fingerprint);
  const payload = Buffer.concat([Buffer.from(fingerprint + '\n'), metadata, Buffer.from('\n'), bytes]);
  if (payload.length > 4400000) fail(413, 'The screenshot and order details are too large. Choose a smaller screenshot.');
  try {
    await store.put(pendingPath(key), payload, 'application/octet-stream');
  } catch (e) {
    const previous = await queuedFingerprint(store, key);
    if (previous) return existing(null, previous);
    const saved = await readResult(store, key);
    if (saved) return existing(saved, saved.fingerprint);
    throw e;
  }
  const savedDuringUpload = await readResult(store, key);
  return savedDuringUpload ? existing(savedDuringUpload, savedDuringUpload.fingerprint) : { pending: true };
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

function queueReceipt(id, result) {
  if (result?.ok === true && result.data?.id === id &&
      result.data.status === 'under_review' && Number.isFinite(Date.parse(result.data.submittedAt))) {
    const { number, submittedAt, status } = result.data;
    return { ok: true, data: { id, number, submittedAt, status } };
  }
  if (result?.ok === false && conflicts.includes(result.code))
    return { ok: false, code: result.code };
  fail(400, 'Invalid order status.');
}

async function preserveForReview(store, path, id, key) {
  const stream = await store.get(path);
  if (!stream) throw Error('Payment proof is unavailable.');
  const contents = Buffer.from(await new Response(stream).arrayBuffer());
  const end = contents.indexOf(10, 65);
  const order = JSON.parse(contents.toString('utf8', 65, end));
  const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
  const mime = order.proof?.mime;
  if (order.id !== id || !Object.hasOwn(extensions, mime)) throw Error('Invalid payment proof.');
  const review = `${root}review/${id}/${key}/`;
  for (const [name, body, type] of [
    ['order.json', JSON.stringify(order), 'application/json'],
    ['payment-screenshot.' + extensions[mime], contents.subarray(end + 1), mime]
  ]) {
    const target = review + name;
    if (!await store.has(target)) await store.put(target, body, type);
  }
}

export function createQueueWorker({ env, store = queueStore(env) }) {
  return async (req) => {
    try {
      if (req.method !== 'POST' || new URL(req.url).origin !== siteURL(env.MARC_SITE_URL))
        return json({ ok: false }, 404);
      const request = workerRequest(await readJSON(req, 8000), env.MARC_SCRIPT_SECRET);
      if (!request) return json({ ok: false }, 403);
      if (!env.BLOB_READ_WRITE_TOKEN) return json({ ok: false }, 503);
      const { action, key, cursor } = request;
      if (action === 'check') {
        const checkPath = `${root}checks/${randomUUID()}.txt`;
        await store.put(checkPath, 'ready', 'text/plain', 1);
        try {
          const stream = await store.get(checkPath);
          if (!stream || await new Response(stream).text() !== 'ready') throw Error('Queue check failed.');
        } finally {
          await store.remove(checkPath);
        }
        return json({ ok: true });
      }
      if (action === 'list') {
        const prefix = `${root}pending/`;
        if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 2000))
          return json({ ok: false }, 400);
        const page = await store.list(prefix, cursor);
        const jobs = page.paths.map((p) => p.slice(prefix.length, -4)).filter((p) => sha256Pattern.test(p));
        return json({ jobs, cursor: page.cursor });
      }
      if (!['read', 'finish'].includes(action) || typeof key !== 'string' || !sha256Pattern.test(key))
        return json({ ok: false }, 400);
      const path = pendingPath(key);
      const alreadySaved = await readResult(store, key);
      if (alreadySaved) {
        await store.remove(path);
        return new Response(null, { status: 204, headers });
      }
      if (action === 'read') {
        const job = await store.get(path);
        if (job) return new Response(job, { headers: { ...headers, 'Content-Type': 'application/octet-stream' } });
        return new Response(null, { status: 204, headers });
      }
      if (action === 'finish') {
        const { id, fingerprint, result } = request;
        if (!orderPattern.test(id || '') || !sha256Pattern.test(fingerprint || ''))
          return json({ ok: false }, 400);
        const receipt = queueReceipt(id, result);
        if (fingerprint !== await queuedFingerprint(store, key))
          return json({ ok: false }, 409);
        if (!receipt.ok) await preserveForReview(store, path, id, key);
        // Keep a receipt for longer than the 7-day lifetime of a checkout quote.
        await store.put(resultPath(key), JSON.stringify({ ...receipt, fingerprint }), 'application/json', 30);
        await store.remove(path);
        return new Response(null, { status: 204, headers });
      }
      return json({ ok: false }, 400);
    } catch {
      return json({ ok: false }, 503);
    }
  };
}
