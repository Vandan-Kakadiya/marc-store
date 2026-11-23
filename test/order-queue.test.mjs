import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createCheckout } from '../server/checkout.js';
import { seal, secret } from '../server/common.js';
import { accountKey } from '../server/account-store.js';
import { createQueueWorker } from '../server/order-queue.js';
import { googleFixture } from './google-fixture.mjs';

function privateStore() {
  const blobs = new Map();
  const state = { unavailable: false, loseWriteReply: false, failDelete: false };
  function copyBody(body) {
    return Buffer.isBuffer(body) ? body : Buffer.from(body);
  }
  return {
    blobs,
    state,
    async get(path) {
      if (state.unavailable) throw Error('Blob temporarily unavailable');
      const body = blobs.get(path);
      return body ? new Response(body).body : null;
    },
    async has(path) { return blobs.has(path); },
    async put(path, body) {
      if (blobs.has(path)) throw Error('Blob already exists');
      blobs.set(path, copyBody(body));
      if (state.loseWriteReply && path.includes('/pending/')) {
        state.loseWriteReply = false;
        throw Error('Blob upload committed but the response was lost');
      }
    },
    async remove(path) {
      if (state.failDelete) throw Error('Could not remove pending blob');
      blobs.delete(path);
    },
    async list(prefix) {
      return { paths: [...blobs.keys()].filter((path) => path.startsWith(prefix)) };
    }
  };
}

function setup() {
  const f = googleFixture();
  const { env, fetcher, script, state, props } = f;
  env.MARC_ORDER_QUEUE_ENABLED = '1';
  env.BLOB_READ_WRITE_TOKEN = 'test-private-store';
  delete props.LEGACY_TAB;
  script.checkOrderStorage();
  state.deployed = f.catalogue();
  const store = privateStore();
  const sessions = new Map(), cookies = new Map();
  const accounts = {
    async read(kind, key) { return sessions.get(key) || null; },
    async remove(kind, key, version) {
      if (sessions.get(key)?.version === version) sessions.delete(key);
    }
  };
  const checkout = createCheckout({ env, fetcher, store, accounts });
  const worker = createQueueWorker({ env, store });
  function signIn(sub) {
    const sessionId = secret();
    sessions.set(accountKey(env, { sub }), { version: sessionId, value: { id: sessionId } });
    const cookie = '__Host-marc-vercel-user=' + seal({
      sub, sessionId, googleEmail: true, name: 'Buyer ' + sub, email: sub + '@iimtrichy.ac.in',
      expires: Date.now() + 3600000
    }, 'buyer session v3', env.MARC_SESSION_KEY);
    cookies.set(sub, cookie);
    return cookie;
  }
  const buyer = (sub = 'buyer-1') => cookies.get(sub) || signIn(sub);
  const origin = env.MARC_SITE_URL;
  const post = (action, body, cookie = buyer()) => checkout(new Request(
    origin + '/api/checkout?action=' + action, {
      method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(body)
    }));
  const fields = () => ({
    id: randomUUID(), version: state.deployed.version,
    items: [{ sku: 'POLO-W-M', qty: 1 }],
    contact: { name: 'MARC Test Buyer', phone: '9876543210', affiliation: 'PGPM 2026-28', roll: '0260010' }
  });
  const quote = async (cookie, options = {}) => {
    const response = await post('quote', { ...fields(), ...options }, cookie);
    const order = await response.json();
    assert.equal(response.status, 200, JSON.stringify(order));
    return order;
  };
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 77]);
  const utr = (n) => String(n + 200000000000);
  const place = (order, n, bytes = png, cookie = buyer()) => {
    const form = new FormData();
    form.set('quote', order.token);
    form.set('paidWith', 'GPay');
    form.set('utr', utr(n));
    form.set('proof', new Blob([bytes], { type: 'image/png' }), 'payment.png');
    return checkout(new Request(origin + '/api/checkout?action=place', {
      method: 'POST', headers: { cookie, origin }, body: form
    }));
  };
  const envelope = (data, issuedAt = Date.now()) => {
    const payload = JSON.stringify(data);
    const signature = createHmac('sha256', env.MARC_SCRIPT_SECRET)
      .update('MARC order queue\n' + issuedAt + '\n' + payload).digest('hex');
    return { issuedAt, payload, signature };
  };
  const workerPost = (body) => worker(new Request(origin + '/api/order-queue', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  }));
  const work = (data) => workerPost(envelope(data));
  const status = (order, cookie) => post('status', { quote: order.token }, cookie);
  function install() {
    state.fetchQueue = () => ({ getResponseCode: () => 200 });
    script.installOrderQueue();
    script.installOrderQueue();
    assert.equal(f.triggers.length, 1);
  }
  async function drain({ testLease = false, finish = true } = {}) {
    // Apps Script's UrlFetch is synchronous. Capture real route responses to
    // supply those bytes, then replay the worker's signed acknowledgements.
    const list = await work({ action: 'list' });
    assert.equal(list.status, 200);
    const page = await list.json();
    const reads = new Map();
    for (const key of page.jobs) {
      const response = await work({ action: 'read', key });
      assert.ok(response.status === 200 || response.status === 204);
      reads.set(key, { code: response.status, bytes: new Uint8Array(await response.arrayBuffer()) });
    }
    const acknowledgements = [];
    let leaseChecked = false;
    state.fetchQueue = (call) => {
      const body = JSON.parse(call.payload);
      const data = JSON.parse(body.payload);
      assert.equal(body.signature, envelope(data, body.issuedAt).signature);
      assert.equal(state.locked, false);
      if (data.action === 'list') {
        if (testLease && !leaseChecked) {
          leaseChecked = true;
          script.processOrderQueue();
        }
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify(page) };
      }
      if (data.action === 'read') {
        const result = reads.get(data.key);
        return { getResponseCode: () => result.code, getContent: () => result.bytes };
      }
      assert.equal(data.action, 'finish');
      acknowledgements.push(body);
      return { getResponseCode: () => 204 };
    };
    script.processOrderQueue();
    assert.equal(props.ORDER_QUEUE_LEASE, undefined);
    if (testLease) assert.ok(leaseChecked);
    if (!finish) return acknowledgements;
    for (const ack of acknowledgements) assert.equal((await workerPost(ack)).status, 204);
    return acknowledgements;
  }
  return { ...f, store, quote, fields, place, buyer, signIn, post, status, work, envelope, workerPost, install, drain, png };
}

test('75 simultaneous Place order requests finish once each with one Apps Script worker', { timeout: 45000 }, async () => {
  const f = setup();
  f.install();
  const count = 75;
  const quotes = await Promise.all(Array.from({ length: count }, (_, index) => f.quote(f.buyer('buyer-' + index))));
  const screenshot = Buffer.alloc(1536 * 1024);
  screenshot.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const fullSize = Buffer.alloc(4 * 1024 * 1024);
  fullSize.set(screenshot.subarray(0, 8));
  const sent = await Promise.all(quotes.map((q, i) => f.place(q, i,
    i === 0 ? fullSize : screenshot, f.buyer('buyer-' + i))));
  const statuses = await Promise.all(sent.map(async (response) => ({ code: response.status, data: await response.json() })));
  assert.equal(statuses.filter(({ code, data }) => code === 202 && data.status === 'processing').length, count);
  assert.equal(f.state.orderCalls, 0);
  assert.equal(f.orders.rows.length - 1, count);
  assert.ok(f.orders.rows.slice(1).every((row) => !row[1] && !row[11]));
  assert.equal(f.files.size, 0);
  const numbers = statuses.map(({ data }) => data.number);
  assert.deepEqual(new Set(numbers),
    new Set(Array.from({ length: count }, (_, i) => 'MARC_0260010_' + (i + 1))));
  assert.equal((await f.status(quotes[0], f.buyer('buyer-1'))).status, 403);
  assert.equal((await f.status(quotes[0], '')).status, 401);
  const queued = await f.status(quotes[0], f.buyer('buyer-0'));
  assert.equal(queued.status, 202);
  assert.equal((await queued.json()).number, numbers[0]);
  const drained = await f.drain({ testLease: true });
  assert.equal(drained.length, count);
  assert.equal(f.files.size, count);
  assert.equal(f.orders.rows.length - 1, count);
  assert.equal(new Set(f.orders.rows.slice(1).map((row) => row[11])).size, count);
  assert.equal(new Set(f.orders.rows.slice(1).map((row) => row[10])).size, count);
  assert.equal([...f.store.blobs.keys()].filter((path) => path.includes('/pending/')).length, 0);
  const results = await Promise.all(quotes.map(async (q, i) => {
    const response = await f.status(q, f.buyer('buyer-' + i));
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.id, q.id);
    assert.equal(data.status, 'under_review');
    assert.ok(data.token);
    return data;
  }));
  assert.deepEqual(results.map(({ number }) => number), numbers);
});

test('retrying an upload, a lost Drive result and a failed pending cleanup keep the same receipt', async () => {
  const f = setup();
  const order = await f.quote();
  f.store.state.loseWriteReply = true;
  const same = await Promise.all(Array.from({ length: 5 }, () => f.place(order, 80)));
  assert.ok(same.every((reply) => reply.status === 202));
  const accepted = await Promise.all(same.map((response) => response.json()));
  assert.deepEqual(new Set(accepted.map(({ number }) => number)), new Set(['MARC_0260010_1']));
  assert.equal(f.store.blobs.size, 2);
  assert.equal((await f.place(order, 81)).status, 409);
  f.state.driveFailure = true;
  assert.equal((await f.drain()).length, 0);
  assert.equal((await f.status(order)).status, 202);
  assert.equal(f.orders.rows[1][2], 'Saving proof');
  f.state.driveFailure = false;
  f.state.driveLostReply = true;
  f.state.flushFailureAfterDrive = true;
  assert.equal((await f.drain()).length, 0);
  assert.equal(f.files.size, 1);
  // Google has saved the row, but the reply to the queue worker was lost.
  assert.equal((await f.drain({ finish: false })).length, 1);
  assert.equal((await f.status(order)).status, 202);
  assert.equal(f.orders.rows.length, 2);
  const [ack] = await f.drain({ finish: false });
  assert.equal(f.files.size, 1);
  f.store.state.failDelete = true;
  assert.equal((await f.workerPost(ack)).status, 503);
  const receipt = await (await f.status(order)).json();
  f.store.state.failDelete = false;
  assert.equal((await f.workerPost(ack)).status, 204);
  const retry = await (await f.place(order, 80)).json();
  assert.equal(retry.number, receipt.number);
  assert.equal(retry.submittedAt, receipt.submittedAt);
  assert.equal(f.orders.rows.length, 2);
  assert.equal(f.files.size, 1);
  assert.equal(f.store.blobs.size, 2);
});

test('a duplicated transaction ID keeps one order and a private payment submission for review', async () => {
  const f = setup();
  const first = await f.quote();
  const second = await f.quote();
  assert.equal((await f.place(first, 90)).status, 202);
  assert.equal((await f.place(second, 90)).status, 202);
  await f.drain();
  const states = await Promise.all([first, second].map(async (order) => (await (await f.status(order)).json()).status));
  assert.deepEqual(states, ['under_review', 'needs_attention']);
  assert.equal(f.orders.rows.length, 2);
  assert.equal(f.files.size, 1);
  const review = [...f.store.blobs.keys()].filter((path) => path.includes('/review/' + second.id + '/'));
  assert.equal(review.length, 2);
  const savedProof = f.store.blobs.get(review.find((path) => path.endsWith('/payment-screenshot.png')));
  assert.deepEqual(savedProof, f.png);
});

test('orders use their original collection Sheet and its order ID sequence', async () => {
  const f = setup();
  const old = await f.quote();
  const priorCollection = f.state.deployed.collection;
  assert.equal((await f.place(old, 100)).status, 202);
  const queuedLater = await f.quote();
  const nextBook = f.newBook('next-sheet');
  f.props.RESPONSE_SHEET_ID = 'next-sheet';
  f.props.FORM_ID = 'next-form';
  f.script.checkOrderStorage();
  f.state.deployed = f.catalogue();
  assert.notEqual(f.state.deployed.collection, priorCollection);
  const next = await f.quote();
  assert.equal((await f.place(next, 101)).status, 202);
  assert.equal((await f.place(queuedLater, 102)).status, 202);
  await f.drain();
  const rowIds = (sheet) => new Set(sheet.rows.slice(1).map((row) => row[0]));
  assert.deepEqual(rowIds(f.orders), new Set([old.id, queuedLater.id]));
  assert.deepEqual(rowIds(nextBook.getSheetByName('MARC Website Orders')), new Set([next.id]));
  assert.equal(f.files.size, 3);
  const [oldReceipt, nextReceipt, lateReceipt] = await Promise.all([old, next, queuedLater].map(async (order) => {
    const response = await f.status(order);
    assert.equal(response.status, 200);
    return response.json();
  }));
  assert.equal(nextReceipt.number, 'MARC_0260010_1');
  assert.deepEqual(new Set([oldReceipt.number, lateReceipt.number]),
    new Set(['MARC_0260010_1', 'MARC_0260010_2']));
});

test('a queued order keeps its MARC ID and saves after the buyer signs out', async () => {
  const f = setup();
  const desktop = f.buyer('buyer-1');
  const order = await f.quote(desktop);
  const pending = await f.place(order, 120, f.png, desktop);
  assert.equal(pending.status, 202);
  const submitted = await pending.json();
  assert.equal(submitted.number, 'MARC_0260010_1');
  assert.equal((await f.post('logout', {}, desktop)).status, 200);
  assert.equal((await f.status(order, desktop)).status, 401);

  await f.drain();
  const phone = f.signIn('buyer-1');
  const saved = await (await f.status(order, phone)).json();
  assert.equal(saved.number, submitted.number);
  assert.equal(saved.status, 'under_review');
  const [history] = await (await f.post('history', {}, phone)).json();
  assert.equal(history.number, submitted.number);
});

test('the queue retains the proof when the early reservation is temporarily unavailable', async () => {
  const f = setup();
  const original = f.script.reserveQueuedOrder_;
  f.script.reserveQueuedOrder_ = () => ({ ok: false, code: 'busy' });
  const order = await f.quote();
  const pending = await f.place(order, 121);
  assert.equal(pending.status, 202);
  assert.equal((await pending.json()).number, undefined);
  f.script.reserveQueuedOrder_ = original;

  await f.drain();
  const saved = await (await f.status(order)).json();
  assert.equal(saved.number, 'MARC_0260010_1');
  assert.ok(saved.token);
});

test('the queue fails safely when unavailable and rejects unsigned or expired worker requests', async () => {
  const f = setup();
  const order = await f.quote();
  assert.equal((await f.work({ action: 'check' })).status, 200);
  assert.equal((await f.workerPost({ action: 'list' })).status, 403);
  assert.equal((await f.workerPost(f.envelope({ action: 'list' }, Date.now() - 360000))).status, 403);
  assert.equal((await f.workerPost({ ...f.envelope({ action: 'list' }), payload: '{}' })).status, 403);
  f.store.state.unavailable = true;
  assert.equal((await f.place(order, 110)).status, 503);
  assert.equal(f.state.orderCalls, 0);
  assert.equal(f.store.blobs.size, 0);
  f.store.state.unavailable = false;
  assert.equal((await f.place(order, 110)).status, 202);
  f.env.MARC_ORDER_QUEUE_ENABLED = '0';
  assert.equal((await f.place(order, 110)).status, 202);
  assert.equal(f.state.orderCalls, 0);
  f.env.MARC_ORDER_QUEUE_ENABLED = '1';
  delete f.env.BLOB_READ_WRITE_TOKEN;
  assert.equal((await f.post('quote', f.fields())).status, 503);
});
