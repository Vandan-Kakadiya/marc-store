import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAuth } from '../../server/auth.js';
import { createCheckout } from '../../server/checkout.js';
import { googleFixture } from '../google-fixture.mjs';

const proof = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRc0AAAAASUVORK5CYII=',
  'base64'
);

async function shop() {
  const data = googleFixture();
  const { env, fetcher, state } = data;
  const auth = createAuth({ env, fetcher });
  const checkout = createCheckout({ env, fetcher });
  const origin = env.MARC_SITE_URL;
  const start = await auth.start(new Request(origin + '/api/auth/start'));
  const authState = new URL(start.headers.get('location')).searchParams.get('state');
  const signIn = await auth.callback(new Request(
    origin + '/api/auth/callback?state=' + authState + '&code=test',
    { headers: { cookie: start.headers.getSetCookie()[0].split(';')[0] } }
  ));
  assert.equal(signIn.status, 303);
  const cookie = signIn.headers.getSetCookie()[1].split(';')[0];

  async function api(action, body) {
    const headers = { origin, cookie };
    if (!(body instanceof FormData)) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const response = await checkout(new Request(origin + '/api/checkout?action=' + action, {
      method: 'POST', headers, body
    }));
    return { status: response.status, body: await response.json() };
  }
  async function quote(index) {
    const response = await api('quote', {
      id: randomUUID(),
      version: state.deployed.version,
      paidWithSelection: true,
      items: [{ sku: 'POLO-W-M', qty: 1 }],
      contact: {
        name: 'Fixture Buyer ' + index, phone: '9876543210',
        affiliation: 'PGPM 2026-28', roll: String(2600000 + index)
      }
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  }
  function place(token, reference) {
    const form = new FormData();
    form.set('quote', token);
    form.set('utr', String(reference).padStart(12, '0'));
    form.set('paidWith', 'GPay');
    form.set('proof', new Blob([proof], { type: 'image/png' }), 'fixture.png');
    return api('place', form);
  }
  return { ...data, quote, place, history: () => api('history', { tokens: [] }) };
}

function summarize(responses) {
  const status = {};
  for (const response of responses)
    status[response.status] = (status[response.status] || 0) + 1;
  return status;
}

async function burstTests() {
  const store = await shop();
  const order = await store.quote(0);
  const repeats = await Promise.all(Array.from({ length: 64 }, () => store.place(order.token, 1)));
  assert.deepEqual(summarize(repeats), { 200: 64 });
  assert.equal(new Set(repeats.map(({ body }) => body.number)).size, 1);
  assert.equal(store.orders.rows.length, 2);
  assert.equal(store.files.size, 1);
  const quotes = await Promise.all(Array.from({ length: 64 }, (_, i) => store.quote(i + 1)));
  const competing = await Promise.all(quotes.map(({ token }) => store.place(token, 2)));
  assert.deepEqual(summarize(competing), { 200: 1, 409: 63 });
  assert.equal(store.orders.rows.length, 3);
  assert.equal(store.files.size, 2);
  console.log(JSON.stringify({ test: 'retries and reused reference', attempts: 128, savedOrders: 2, proofFiles: 2 }));
}

async function sustainedTests() {
  const store = await shop();
  const responses = [];
  for (let start = 0; start < 1100; start += 32) {
    const quantity = Math.min(1100 - start, 32);
    const quotes = await Promise.all(Array.from({ length: quantity }, (_, i) => store.quote(start + i)));
    responses.push(...await Promise.all(quotes.map(({ token }, i) => store.place(token, start + i + 10000))));
  }
  const status = summarize(responses);
  const accepted = responses.filter((response) => response.status === 200);
  assert.equal(new Set(accepted.map(({ body }) => body.number)).size, accepted.length);
  assert.equal(store.files.size, accepted.length);
  assert.equal(store.orders.rows.length - 1, accepted.length);
  console.log(JSON.stringify({ test: 'sustained checkout on a 1000-row grid', attempts: responses.length, status }));
  return accepted.length === responses.length;
}

async function volumeTests() {
  const store = await shop();
  store.script.checkOrderStorage();
  store.orders.insertRowsAfter(store.orders.getMaxRows(), 8000);
  const historyLines = Array.from({ length: 5 }, (_, i) => ({
    sku: 'ITEM-' + i, name: 'IIM Trichy merchandise for checkout fixtures ' + i,
    colour: 'MARC store navy and white', size: 'Medium', paise: 79900, qty: 1
  }));
  const buyerKey = store.script.buyerKey_(store.state.profile.sub);
  const otherKey = store.script.buyerKey_('other-fixture');
  const ownSnapshot = JSON.stringify({ key: buyerKey, lines: historyLines });
  const otherSnapshot = JSON.stringify({ key: otherKey, lines: historyLines });
  for (let i = 0; i < 8000; i++) {
    const mine = i < 3;
    const roll = String(2610000 + i);
    store.orders.rows.push([
      randomUUID(), '2026-11-21T10:00:00.000Z', 'Verified',
      'Fixture Buyer', mine ? 'old-verified-address@example.test' : 'other@example.test',
      '9876543210', 'PGPM 2026-28', roll, 'Merchandise fixture', 799,
      String(i + 30000).padStart(12, '0'), 'https://drive.google.com/file/d/fixture/view',
      'fixture', 'MARC_' + roll + '_1', mine ? ownSnapshot : otherSnapshot, 'GPay'
    ]);
  }
  const read = store.orders.reads;
  read.enabled = true;
  const history = await store.history();
  assert.equal(history.status, 200);
  assert.equal(history.body.length, 3);
  console.log(JSON.stringify({ test: 'history on a large sheet', orderRows: 8000, receipts: 3, cells: read.cells, textBytes: read.textBytes }));
  read.cells = 0;
  read.textBytes = 0;
  const order = await store.quote(980);
  const result = await store.place(order.token, 40001);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  console.log(JSON.stringify({ test: 'new order on a large sheet', orderRows: 8000, cells: read.cells, textBytes: read.textBytes }));
}

await burstTests();
const allSaved = await sustainedTests();
await volumeTests();
if (!allSaved) process.exitCode = 1;
