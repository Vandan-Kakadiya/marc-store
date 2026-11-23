import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createAuth } from '../server/auth.js';
import { createCheckout } from '../server/checkout.js';
import { seal, unseal } from '../server/common.js';
import { callScript } from '../server/script-client.js';
import { googleFixture } from './google-fixture.mjs';

const setup = () => {
  const store = googleFixture(),
    { env, fetcher } = store;
  const origin = env.MARC_SITE_URL;
  const auth = createAuth({ env, fetcher }),
    checkout = createCheckout({ env, fetcher });
  const cookieValue = (name) => name.split(';')[0];
  const call = (
    action,
    { method = 'GET', headers = {}, json, form, raw } = {}
  ) =>
    checkout(
      new Request(origin + '/api/checkout?action=' + action, {
        method,
        headers: {
          origin,
          ...(json ? { 'content-type': 'application/json' } : {}),
          ...headers
        },
        body: json ? JSON.stringify(json) : form || raw
      })
    );
  async function login(expected = 303) {
    const begin = await auth.start(new Request(origin + '/api/auth/start'));
    assert.equal(begin.status, 303);
    const dest = new URL(begin.headers.get('location'));
    assert.equal(dest.hostname, 'accounts.google.com');
    assert.equal(
      dest.searchParams.get('redirect_uri'),
      origin + '/api/auth/callback'
    );
    const callback =
      origin +
      '/api/auth/callback?state=' +
      dest.searchParams.get('state') +
      '&code=example';
    assert.equal((await auth.callback(new Request(callback))).status, 401);
    const response = await auth.callback(
      new Request(callback, {
        headers: { cookie: cookieValue(begin.headers.getSetCookie()[0]) }
      })
    );
    assert.equal(response.status, expected);
    if (expected !== 303) return response;
    assert.equal(response.headers.get('location'), '/checkout.html');
    assert.equal(
      createHash('sha256')
        .update(store.state.lastOAuthTokenRequest.get('code_verifier'))
        .digest('base64url'),
      dest.searchParams.get('code_challenge')
    );
    const ct = response.headers.getSetCookie()[1];
    assert.match(ct, /Secure; HttpOnly; SameSite=Lax/);
    assert.match(ct, /Max-Age=1200$/);
    return cookieValue(ct);
  }
  const json = async (response, status = 200) => {
    const data = await response.json();
    assert.equal(response.status, status, JSON.stringify(data));
    return data;
  };
  const post = (cookie, action, input) =>
    call(action, { method: 'POST', headers: { cookie }, json: input });
  const quoteFields = {
    id: randomUUID(),
    version: store.state.deployed.version,
    items: [{ sku: 'POLO-W-M', qty: 2, paise: 1 }],
    contact: {
      name: '=Buyer',
      phone: '9876543210',
      affiliation: 'PGPM 2026-28',
      roll: '0260010',
      email: 'spoof@example.test'
    }
  };
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 121, 90]);
  const place = (cookie, quote, utr, bytes = png, mime = 'image/png', paidWith = 'GPay') => {
    const form = new FormData();
    form.set('quote', quote);
    form.set('utr', utr);
    form.set('proof', new Blob([bytes], { type: mime }), 'proof');
    if (paidWith !== null) form.set('paidWith', paidWith);
    return call('place', { method: 'POST', headers: { cookie }, form });
  };
  return { ...store, login, call, json, post, quoteFields, place, png };
};
test('checkout login, contact and quoted price complete without an Apps Script request', async () => {
  const f = setup(),
    { state, login, call, json, post, quoteFields } = f;
  assert.equal((await json(await call('session'))).user, null);
  await json(await call('quote', { method: 'POST', json: quoteFields }), 401);
  const cookie = await login();
  assert.equal(
    (await json(await call('session', { headers: { cookie } }))).user.email,
    state.profile.email
  );
  for (const affiliation of [
    'PGPM 2026-28',
    'PGPM 2025-27',
    'PGPM HR 2026-28',
    'PGPM HR 2025-27'
  ])
    await json(
      await post(cookie, 'quote', {
        ...quoteFields,
        contact: { ...quoteFields.contact, affiliation, roll: '' }
      }),
      400
    );
  await json(
    await post(cookie, 'quote', { ...quoteFields, version: 'old' }),
    409
  );
  await json(
    await post(cookie, 'quote', {
      ...quoteFields,
      items: [{ sku: 'POLO-W-M', qty: 6 }]
    }),
    400
  );
  await json(
    await call('quote', {
      method: 'POST',
      headers: { cookie, origin: 'https://another.example' },
      json: quoteFields
    }),
    403
  );
  const order = await json(await post(cookie, 'quote', quoteFields));
  assert.equal(order.total, 159800);
  assert.equal(order.payment.payee, 'IIMT MART');
  assert.equal(
    (await json(await post(cookie, 'resume', { quote: order.token }))).total,
    159800
  );
  await json(
    await post(cookie, 'resume', { quote: 'changed' + order.token }),
    409
  );
  assert.equal(state.orderCalls, 0);
  assert.equal(state.catalogueCalls, 0);
  assert.equal(f.files.size, 0);
  assert.equal(f.orders.rows.length, 0);
  for (const contact of [
    { phone: '0123456789' },
    { phone: '+919876543210' },
    { phone: ' 9876543210' },
    { phone: '9876543210.0' },
    { phone: '987654321A' },
    { phone: 9876543210 },
    { roll: '026001' },
    { roll: '02600100' },
    { roll: '02600A1' },
    { roll: '02600.1' }
  ])
    await json(await post(cookie, 'quote', {
      ...quoteFields, contact: { ...quoteFields.contact, ...contact }
    }), 400);
});

test('full order, partial storage failure, lost response, retry and cross-account receipt isolation', async () => {
  const f = setup(),
    { state, json, post, place, quoteFields, files, orders } = f;
  const cookie = await f.login(),
    quote = await json(await post(cookie, 'quote', quoteFields));
  await json(await place('', quote.token, '000001234567'), 401);
  await json(await place(cookie, quote.token, '123456'), 400);
  await json(
    await place(cookie, quote.token, '000001234567', Buffer.from('not png')),
    400
  );
  await json(
    await place(
      cookie,
      quote.token,
      '000001234567',
      Buffer.alloc(4 * 1024 * 1024 + 1)
    ),
    400
  );
  assert.equal(state.orderCalls, 0);
  // A change in Google Forms cannot reprice a customer who already reached payment.
  state.choices[0] = 'POLO-W-M | MARC Polo | White | M | 999';
  state.deployed = f.catalogue();
  state.driveFailure = true;
  await json(await place(cookie, quote.token, '000001234567'), 503);
  assert.equal(files.size, 0);
  assert.equal(orders.rows[1][2], 'Saving proof');
  assert.equal(orders.rows[1][1], '');
  state.driveFailure = false;
  state.flushFailureAfterDrive = true;
  await json(await place(cookie, quote.token, '000001234567'), 503);
  assert.equal(files.size, 1);
  assert.equal(orders.rows[1][1], '');
  state.lostReply = true;
  await json(await place(cookie, quote.token, '000001234567'), 503);
  const receipt = await json(await place(cookie, quote.token, '000001234567'));
  assert.equal(receipt.total, 159800);
  assert.equal(receipt.id, quoteFields.id);
  assert.equal(receipt.status, 'under_review');
  assert.equal(orders.rows.length, 2);
  assert.equal(files.size, 1);
  const row = orders.rows[1];
  assert.equal(row[1], receipt.submittedAt);
  assert.equal(row[2], 'Under review');
  assert.equal(row[3], "'=Buyer");
  assert.equal(row[4], "'buyer@iimtrichy.ac.in");
  assert.equal(row[7], "'0260010");
  assert.equal(row[10], "'000001234567");
  assert.match(row[11], /^https:\/\/drive\.google\.com\/file\/d\//);
  assert.equal(receipt.number, 'MARC_0260010_1');
  assert.equal(orders.rows[1][13], receipt.number);
  assert.match([...files.keys()][0], /^0260010_Buyer_[a-f0-9-]+\.png$/);
  assert.equal(receipt.proof, undefined);
  await json(await place(cookie, quote.token, '000001234568'), 409);
  const old = await json(
    await post(cookie, 'receipts', { tokens: [receipt.token] })
  );
  assert.equal(old[0].id, quoteFields.id);
  state.profile = {
    ...state.profile,
    email: 'other@iimtrichy.ac.in',
    sub: 'buyer-2'
  };
  const other = await f.login();
  assert.deepEqual(
    await json(await post(other, 'receipts', { tokens: [receipt.token] })),
    []
  );
  await json(await place(other, quote.token, '000001234567'), 403);

  const second = await json(
    await post(cookie, 'quote', {
      ...quoteFields,
      id: randomUUID(),
      version: state.deployed.version,
      contact: { ...quoteFields.contact, affiliation: 'Staff', roll: 'ignored' }
    })
  );
  await json(await place(cookie, second.token, '000001234567'), 409);
  await json(await place(cookie, second.token, '001234560001'), 409);
  state.confirmFailure = true;
  await json(await place(cookie, second.token, '001234560002'), 503);
  const again = await json(await place(cookie, second.token, '001234560002'));
  assert.equal(again.total, 199800);
  assert.equal(again.number, 'MARC_STAFF_1');
  assert.equal(orders.rows[2][7], "'");
  assert.equal(orders.rows.length, 3);
  assert.equal(files.size, 2);
  assert.equal(state.catalogueCalls, 0);
});

test('new checkouts validate and store the payment method and bank reference', async () => {
  const f = setup();
  const { env, json, post, place, orders, quoteFields, png, state } = f;
  const cookie = await f.login();
  const bankMethod = 'Bank transfer (NEFT / IMPS / RTGS)';
  const fields = { ...quoteFields, paidWithSelection: true };
  const placeWith = (quote, reference, method) =>
    place(cookie, quote.token, reference, png, 'image/png', method);
  const noBank = await json(await post(cookie, 'quote', fields));
  assert.equal(noBank.payment.bank, undefined);
  await json(await placeWith(noBank, '001234567890', bankMethod), 400);
  await json(await placeWith(noBank, '001234567890', null), 400);
  await json(await placeWith(noBank, '001234567890', 'Unknown'), 400);

  env.MARC_BANK_ACCOUNT_NUMBER = '00123456789';
  env.MARC_BANK_IFSC = 'test0123456';
  const bank = await json(await post(cookie, 'quote', fields));
  assert.equal(state.deployed.payment.bank, undefined);
  assert.deepEqual(bank.payment.bank, {
    accountNumber: '00123456789',
    ifsc: 'TEST0123456'
  });
  assert.equal(bank.payment.payee, 'IIMT MART');
  // A customer can still submit proof for the details they saw when they paid.
  delete env.MARC_BANK_IFSC;
  const resumed = await json(await post(cookie, 'resume', { quote: bank.token }));
  assert.deepEqual(resumed.payment.bank, bank.payment.bank);
  await json(await placeWith(bank, 'A-123', bankMethod), 400);
  await json(await placeWith(bank, 'TESTR26000012345678901', 'GPay'), 400);
  assert.equal(state.orderCalls, 0);
  const receipt = await json(await placeWith(bank, 'testr26000012345678901', bankMethod));
  assert.equal(orders.rows[0][11], 'Payment screenshot');
  const methodColumn = orders.rows[0].indexOf('Paid with');
  assert.equal(methodColumn, 15);
  assert.equal(orders.rows[1][methodColumn], "'" + bankMethod);
  assert.ok(!orders.rows[1][orders.rows[0].indexOf('UPI order reference')]);
  assert.equal(orders.rows[1][10], "'TESTR26000012345678901");
  const retry = await json(await placeWith(bank, 'TESTR26000012345678901', bankMethod));
  assert.equal(retry.number, receipt.number);

  const upi = await json(await post(cookie, 'quote', { ...fields, id: randomUUID() }));
  await json(await placeWith(upi, '001234567890', 'GPay'));
  assert.equal(orders.rows[2][methodColumn], "'GPay");
  await json(await placeWith(upi, '001234567890', 'PhonePe'), 409);
  assert.equal(orders.rows.length, 3);
  assert.equal(orders.rows[2][methodColumn], "'GPay");
});

test('the app and QR use the server quote and payment proof enters review', async () => {
  const f = setup();
  const { call, files, json, orders, place, png, post, props, state } = f;
  props.UPI_MERCHANT_CODE = '5999';
  state.deployed = f.catalogue();
  const cookie = await f.login();
  const fields = {
    ...f.quoteFields,
    version: state.deployed.version,
    items: [{ sku: 'TOTE', qty: 3, paise: 1 }],
    total: 1,
    paidWithSelection: false,
    payment: { upi: 'other@examplebank', payee: 'Another merchant' }
  };
  const response = await post(cookie, 'quote', fields);
  assert.match(response.headers.get('cache-control'), /private, no-store/);
  const quote = await json(response);
  const { upiLink, upiReference, orderQr } = quote.payment;
  const upi = new URL(upiLink);
  assert.equal(upi.protocol, 'upi:');
  assert.equal(upi.hostname, 'pay');
  assert.equal(quote.total, 74850);
  assert.match(upiReference, /^MARC[A-F0-9]{28}$/);
  assert.deepEqual(Object.fromEntries(upi.searchParams), {
    pa: props.UPI_ID,
    pn: props.PAYEE_NAME,
    tr: upiReference,
    tn: 'Order ' + upiReference,
    am: '748.50',
    cu: 'INR',
    mc: '5999'
  });
  assert.match(orderQr, /^data:image\/png;base64,iVBORw0KGgo/);
  const resume = await json(await post(cookie, 'resume', { quote: quote.token }));
  assert.deepEqual(resume.payment, quote.payment);
  const second = await json(await post(cookie, 'quote', { ...fields, id: randomUUID() }));
  assert.notEqual(second.payment.upiReference, upiReference);
  assert.equal(files.size, 0);
  assert.equal(orders.rows.length, 0);
  await json(await place(cookie, quote.token, '000001234567', png, 'image/png', null), 400);
  const form = new FormData();
  form.set('quote', quote.token);
  form.set('utr', '000001234567');
  form.set('paidWith', 'GPay');
  form.set('proof', new Blob([png], { type: 'image/png' }), 'proof');
  form.set('status', 'Verified');
  form.set('total', '1');
  form.set('upiReference', 'arbitrary');
  const saved = await json(await call('place', { method: 'POST', headers: { cookie }, form }));
  assert.equal(saved.status, 'under_review');
  assert.equal(saved.total, 74850);
  assert.equal(orders.rows[1][2], 'Under review');
  assert.equal(orders.rows[1][orders.rows[0].indexOf('UPI order reference')], "'" + upiReference);
  assert.equal(orders.rows[1][10], "'000001234567");
  await json(await place(cookie, second.token, '000001234567'), 409);
});

test('the configured QR is used when no valid receiving UPI ID is configured', async () => {
  const f = setup();
  const cookie = await f.login();
  for (const value of ['', 'upi://pay?pa=unexpected@bank']) {
    f.props.UPI_ID = value;
    f.state.deployed = f.catalogue();
    const quote = await f.json(await f.post(cookie, 'quote', {
      ...f.quoteFields,
      version: f.state.deployed.version
    }));
    assert.equal(quote.payment.qr, f.props.PAYMENT_QR_URL);
    assert.equal(quote.payment.upiLink, undefined);
    assert.equal(quote.payment.orderQr, undefined);
  }
});

test('checkout requires a verified account managed by IIM Trichy', async () => {
  const f = setup();
  const verified = f.state.profile;
  for (const changes of [
    { email: 'buyer@gmail.com', hd: undefined },
    { hd: 'other.edu' },
    { email: 'buyer@external.iimtrichy.ac.in' },
    { email_verified: false }
  ]) {
    f.state.profile = { ...verified, ...changes };
    assert.equal((await f.login(403)).headers.getSetCookie().length, 0);
  }
  const oldExternalCookie = '__Host-marc-vercel-user=' + seal({
    sub: 'external-buyer',
    email: 'buyer@gmail.com',
    googleEmail: true,
    expires: Date.now() + 60000
  }, 'buyer session v2', f.env.MARC_SESSION_KEY);
  await f.json(await f.post(oldExternalCookie, 'quote', f.quoteFields), 401);
});

test('payment proof started with the earlier receiver can finish after an update', async () => {
  const f = setup();
  const cookie = await f.login();
  const quote = await f.json(await f.post(cookie, 'quote', f.quoteFields));
  const old = unseal(quote.token, 'order quote', f.env.MARC_SESSION_KEY, 210000);
  delete old.payment.upiLink;
  delete old.payment.upiReference;
  old.requiresPaidWith = false;
  const token = seal(old, 'order quote', f.env.MARC_SESSION_KEY);
  f.state.driveFailure = true;
  await f.json(await f.place(cookie, token, '001234567890', f.png, 'image/png', null), 503);
  f.state.driveFailure = false;
  await f.json(await f.place(cookie, token, '001234567890', f.png, 'image/png', 'GPay'));
  const methodColumn = f.orders.rows[0].indexOf('Paid with');
  assert.equal(f.orders.rows[1][methodColumn], "'GPay");
  assert.equal(f.orders.rows.length, 2);
  assert.equal(f.files.size, 1);
});

test('per-SKU print fields validate each item and follow the order through to its receipt', async () => {
  const f = setup();
  f.state.choices = [
    'POLO-W-M | MARC Polo | White | M | 799 | print=name,number',
    'POLO-W-L | MARC Polo | White | L | 799',
    'TOTE | Campus Tote | Navy | One size | 249.50 | print=number',
    'CAP | Campus Cap | Navy | One size | 299 | print=name'
  ];
  f.state.deployed = f.catalogue();
  assert.equal(f.state.deployed.ready, true);
  const skuList = f.state.deployed.products.flatMap((product) => product.skus);
  assert.deepEqual(skuList[0].printFields, ['name', 'number']);
  assert.equal(skuList[1].printFields, undefined);
  const cookie = await f.login();
  const makeQuote = (items) => f.post(cookie, 'quote', {
    ...f.quoteFields, version: f.state.deployed.version, items
  });
  const polo = { sku: 'POLO-W-M', qty: 2 };
  const noPrint = await f.json(await makeQuote([polo]));
  assert.equal(noPrint.lines[0].print, undefined);
  await f.json(await makeQuote([{ ...polo, print: [{ name: 'Ananya', number: '7' }] }]), 400);
  for (const number of ['-1', '10000', '1.5', '01X', '1234\n']) {
    await f.json(await makeQuote([{
      ...polo, qty: 1, print: [{ name: 'Ananya', number }]
    }]), 400);
  }
  const somePrint = await f.json(await makeQuote([{
    ...polo, print: [{ name: '   ', number: '08' }, { name: '', number: '' }]
  }]));
  assert.deepEqual(somePrint.lines[0].print, [{ number: '08' }, {}]);
  const quote = await f.json(await makeQuote([
    { ...polo, print: [{ name: ' अनन्या ', number: '0' }, { name: 'Mannat', number: '9999' }] },
    { sku: 'POLO-W-L', qty: 1 },
    { sku: 'TOTE', qty: 1, print: [{ number: '0025' }] },
    { sku: 'CAP', qty: 1, print: [{ name: 'Rahul' }] }
  ]));
  const line = (sku) => quote.lines.find((item) => item.sku === sku);
  assert.deepEqual(line('POLO-W-M').print, [
    { name: 'अनन्या', number: '0' }, { name: 'Mannat', number: '9999' }
  ]);
  assert.deepEqual(line('TOTE').print, [{ number: '0025' }]);
  assert.deepEqual(line('CAP').print, [{ name: 'Rahul' }]);
  assert.equal(line('POLO-W-L').print, undefined);
  assert.equal(quote.total, 294550);

  // A catalogue update can occur while the buyer is on the payment screen.
  f.state.choices = f.state.choices.map((value) => value.split(' | print=')[0]);
  f.state.deployed = f.catalogue();
  const resumed = await f.json(await f.post(cookie, 'resume', { quote: quote.token }));
  assert.deepEqual(resumed.lines, quote.lines);
  const receipt = await f.json(await f.place(cookie, quote.token, '001234567890'));
  assert.deepEqual(receipt.lines, quote.lines);
  const [headers, row] = f.orders.rows;
  assert.equal(row[8].split('\n').length, 4);
  assert.doesNotMatch(row[8], /Name:|Number:/);
  assert.equal(row[headers.indexOf('Name to print (optional)')], "'CAP · Rahul\nPOLO-W-M #1 · अनन्या\nPOLO-W-M #2 · Mannat");
  assert.equal(row[headers.indexOf('Number to print (optional)')], "'POLO-W-M #1 · 0\nPOLO-W-M #2 · 9999\nTOTE · 0025");
  const [history] = await f.json(await f.post(cookie, 'history', { tokens: [] }));
  assert.deepEqual(history.lines, receipt.lines);
});

test('single item print columns keep the name and leading zero on their own', async () => {
  const f = setup();
  f.state.choices[0] += ' | print=name,number';
  f.state.deployed = f.catalogue();
  const cookie = await f.login();
  const quoteInput = {
    ...f.quoteFields,
    version: f.state.deployed.version,
    items: [{ sku: 'POLO-W-M', qty: 1, print: [{ name: 'Sample', number: '08' }] }]
  };
  const quote = await f.json(await f.post(cookie, 'quote', quoteInput));
  await f.json(await f.place(cookie, quote.token, '001234567890'));
  const [headers, row] = f.orders.rows;
  const printName = headers.indexOf('Name to print (optional)');
  const printNumber = headers.indexOf('Number to print (optional)');
  const productOnly = "'1 × MARC Polo / White / M [POLO-W-M]";
  assert.equal(row[8], productOnly);
  assert.equal(row[printName], "'Sample");
  assert.equal(row[printNumber], "'08");

  // An earlier receiver stored the same values in the Items cell.
  row[8] = productOnly + '\n  Name: Sample · Number: 08';
  row[printName] = '';
  row[printNumber] = '';
  f.script.moveExistingPrintDetails();
  assert.equal(row[8], productOnly);
  assert.equal(row[printName], "'Sample");
  assert.equal(row[printNumber], "'08");
  f.script.moveExistingPrintDetails();
  assert.equal(row[8], productOnly);
  assert.equal(row[printNumber], "'08");

  const plain = await f.json(await f.post(cookie, 'quote', {
    ...quoteInput,
    id: randomUUID(),
    items: [{ sku: 'POLO-W-M', qty: 1, print: [{ name: '', number: '' }] }]
  }));
  await f.json(await f.place(cookie, plain.token, '001234567891'));
  const optionalRow = f.orders.rows[2];
  assert.equal(optionalRow[8], productOnly);
  assert.ok(!optionalRow[printName]);
  assert.ok(!optionalRow[printNumber]);
});

test('a personalised SKU keeps all three of its configured photos', () => {
  const f = setup();
  const sku = f.script.parseSku_(
    'KIT | Jersey | Blue | L | 799 | assets/a.webp | assets/b.webp | assets/c.webp | print=Number, Name'
  );
  assert.deepEqual(Array.from(sku.images), ['assets/a.webp', 'assets/b.webp', 'assets/c.webp']);
  assert.deepEqual(Array.from(sku.printFields), ['name', 'number']);
});

test('the supported 100-unit order accepts print details on every unit', async () => {
  const f = setup();
  f.state.sizes = Array.from({ length: 100 }, (_, index) => String(index + 1));
  f.state.choices[0] += ' | print=name,number';
  f.state.deployed = f.catalogue();
  const print = Array.from({ length: 100 }, () => ({ name: 'अ'.repeat(80), number: '9999' }));
  const cookie = await f.login();
  const quote = await f.json(await f.post(cookie, 'quote', {
    ...f.quoteFields,
    version: f.state.deployed.version,
    items: [{ sku: 'POLO-W-M', qty: 100, print }]
  }));
  const receipt = await f.json(await f.place(cookie, quote.token, '001234567890'));
  assert.deepEqual(receipt.lines[0].print, print);
  const [headers, row] = f.orders.rows;
  assert.equal(row[8].split('\n').length, 1);
  assert.equal(row[headers.indexOf('Number to print (optional)')].split('\n').length, 100);
});

test('My orders reads shared receipts, migrates old rows, and protects ownership', async () => {
  const f = setup();
  const { orders, quoteFields, login, post, json, place, state } = f;
  const old = randomUUID();
  orders.rows.push([...f.script.HEADINGS, 'Pickup status']);
  orders.rows[0][11] = 'Private screenshot';
  const screenshotLink = 'https://drive.google.com/file/d/test/view';
  const oldRow = [
    old, new Date(Date.now() - 60000).toISOString(), 'Verified', "'Past Buyer",
    "'BUYER@iimtrichy.ac.in", "'9876543210", 'PGPM 2026-28', "'026001",
    "'1 × Polo / White / M [POLO-W-M]", 799, "'000001234568",
    screenshotLink, 'old-fingerprint',
    'Ready to collect'
  ];
  orders.rows.push(oldRow);
  const deviceA = await login();
  const history = async (cookie, tokens = [], status = 200) =>
    json(await post(cookie, 'history', { tokens }), status);
  await history('', [], 401);
  const [oldReceipt] = await history(deviceA);
  assert.equal(oldReceipt.number, old);
  assert.equal(oldReceipt.items, '1 × Polo / White / M [POLO-W-M]');
  assert.equal(oldReceipt.total, 79900);
  assert.equal(oldReceipt.paymentStatus, 'Verified');
  assert.deepEqual(oldReceipt.lines, []);
  assert.equal(orders.rows[0][11], 'Payment screenshot');
  assert.equal(orders.rows[1][11], screenshotLink);
  assert.equal(orders.rows[1][13], 'Ready to collect');
  assert.equal(typeof JSON.parse(orders.rows[1][15]).key, 'string');

  const quote = await json(await post(deviceA, 'quote', quoteFields));
  const receipt = await json(await place(deviceA, quote.token, '000001234569'));
  assert.equal(receipt.number, 'MARC_0260010_1');
  const retry = await json(await place(deviceA, quote.token, '000001234569'));
  assert.equal(retry.number, receipt.number);
  orders.rows[2][2] = 'Verified';
  const deviceB = await login();
  assert.notEqual(deviceA, deviceB);
  const fromPhone = await history(deviceA);
  const fromLaptop = await history(deviceB);
  assert.deepEqual(fromPhone, fromLaptop);
  assert.equal(fromLaptop[0].number, receipt.number);
  assert.equal(fromLaptop[0].paymentStatus, 'Verified');
  assert.deepEqual(fromLaptop[0].lines, receipt.lines);
  assert.equal(fromLaptop[0].proof, undefined);
  assert.equal(fromLaptop[0].phone, undefined);
  assert.equal(fromLaptop[0].utr, undefined);

  // Exercise receipt lookup for a larger sheet as well as a small one.
  orders.rows.push(...Array.from({ length: 105 }, () => [randomUUID()]));
  state.profile = { ...state.profile, email: 'changed@iimtrichy.ac.in' };
  assert.deepEqual(await history(await login()), fromLaptop);
  state.profile = { ...state.profile, email: 'buyer@iimtrichy.ac.in', sub: 'different-account' };
  const other = await login();
  assert.deepEqual(
    await json(await post(other, 'history', { tokens: [receipt.token], email: 'buyer@iimtrichy.ac.in' })),
    []
  );

});

test('an outstanding six-digit roll order can be submitted after the update', async () => {
  const { env, login, json, post, place, quoteFields } = setup();
  const cookie = await login();
  const quote = await json(await post(cookie, 'quote', quoteFields));
  const earlierQuote = unseal(quote.token, 'order quote', env.MARC_SESSION_KEY, 210000);
  earlierQuote.contact.roll = '026001';
  const oldToken = seal(earlierQuote, 'order quote', env.MARC_SESSION_KEY);
  const receipt = await json(await place(cookie, oldToken, '000001234567'));
  assert.equal(receipt.number, 'MARC_026001_1');
});

test('sessions expire twenty minutes after sign-in for history and checkout', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const { env, script, call, login, json, post, quoteFields } = setup();
  script.Date = Date;
  const cookie = await login();
  const session = async () => json(await call('session', { headers: { cookie } }));
  const info = await session();
  assert.equal(info.sessionRemainingMs, 1200000);
  now += 1199999;
  assert.equal((await session()).sessionRemainingMs, 1);
  await json(await post(cookie, 'history', {}));
  now += 1;
  const expired = await session();
  assert.equal(expired.user, null);
  assert.equal(expired.sessionRemainingMs, 0);
  await json(await post(cookie, 'quote', quoteFields), 401);
  await json(await post(cookie, 'history', {}), 401);
  const legacy = '__Host-marc-vercel-user=' + seal(
    { sub: 'buyer-1', email: 'buyer@example.test', expires: now + 604800000 },
    'buyer session', env.MARC_SESSION_KEY
  );
  assert.equal((await json(await call('session', { headers: { cookie: legacy } }))).user, null);
});

test('signed order endpoint rejects unsigned, changed and expired requests', () => {
  const f = setup(),
    invoke = (contents) =>
      JSON.parse(f.script.doPost({ postData: { contents } }).text);
  assert.equal(invoke('{"action":"placeOrder"}').code, 'unauthorized');
  assert.equal(
    invoke(
      JSON.stringify({
        issuedAt: Date.now(),
        payload: '{"action":"placeOrder","data":{}}',
        signature: '0'.repeat(64)
      })
    ).code,
    'unauthorized'
  );
  assert.equal(
    invoke(
      JSON.stringify({
        issuedAt: Date.now() - 360001,
        payload: '{}',
        signature: '0'.repeat(64)
      })
    ).code,
    'unauthorized'
  );
  assert.equal(f.files.size, 0);
  assert.equal(f.orders.rows.length, 0);
});

test('owner storage check and restricted screenshot access', async () => {
  const f = setup(),
    { state, json, post, place, quoteFields } = f;
  f.script.checkOrderStorage();
  assert.equal(f.orders.rows.length, 1);
  state.publicFolder = true;
  const cookie = await f.login(),
    quote = await json(await post(cookie, 'quote', quoteFields));
  await json(await place(cookie, quote.token, '123456789012'), 503);
  assert.equal(f.orders.rows.length, 1);
  assert.equal(f.files.size, 0);
});

function unlinkFormAndRemoveResponseTab(f) {
  f.script.FormApp.openById(f.props.FORM_ID).getDestinationId = () => null;
  const book = f.script.SpreadsheetApp.openById(f.props.RESPONSE_SHEET_ID);
  const getSheet = book.getSheetByName;
  const name = f.props.LEGACY_TAB;
  book.getSheetByName = (tab) => (tab === name ? null : getSheet(tab));
  return getSheet(name);
}

test('website checkout and earlier receipts work without a Form response destination or tab', async () => {
  const f = setup();
  const cookie = await f.login();
  const firstQuote = await f.json(await f.post(cookie, 'quote', f.quoteFields));
  const first = await f.json(await f.place(cookie, firstQuote.token, '000001234567'));

  unlinkFormAndRemoveResponseTab(f);
  delete f.props.LEGACY_TAB;
  f.script.checkOrderStorage();
  assert.match(f.messages.at(-1), /Order storage is ready.*Ordering is open/);
  const catalogue = f.catalogue();
  assert.deepEqual(catalogue.products, f.state.deployed.products);
  assert.match(catalogue.collection, /^[a-f0-9]{64}$/);
  f.state.deployed = catalogue;

  const fields = { ...f.quoteFields, id: randomUUID(), version: catalogue.version };
  const nextQuote = await f.json(await f.post(cookie, 'quote', fields));
  const next = await f.json(await f.place(cookie, nextQuote.token, '000001234568'));
  const history = await f.json(await f.post(cookie, 'history', {}));
  assert.deepEqual(new Set(history.map(({ id }) => id)), new Set([first.id, next.id]));
  assert.equal(f.orders.rows.length, 3);
  assert.equal(f.files.size, 2);
});

test('a restricted archive still blocks reused references after removing the response tab', async () => {
  const f = setup();
  const old = unlinkFormAndRemoveResponseTab(f);
  const archiveId = 'archived-order-book';
  const { openById } = f.script.SpreadsheetApp;
  f.script.SpreadsheetApp.openById = (id) => id === archiveId
    ? { getSheetByName: (name) => name === old.getName() ? old : null }
    : openById(id);
  f.props.LEGACY_SHEET_ID = archiveId;
  f.script.checkOrderStorage();

  const cookie = await f.login();
  const quote = await f.json(await f.post(cookie, 'quote', f.quoteFields));
  await f.json(await f.place(cookie, quote.token, '001234560001'), 409);
  assert.equal(f.orders.rows.length, 1);
  assert.equal(f.files.size, 0);
  const { getFileById } = f.script.DriveApp;
  f.script.DriveApp.getFileById = (id) => id === archiveId
    ? { getSharingAccess: () => 'ANYONE' }
    : getFileById(id);
  assert.throws(() => f.script.checkOrderStorage(), /Restricted/);
  await f.json(await f.place(cookie, quote.token, '001234560002'), 503);
  assert.equal(f.orders.rows.length, 1);
});

test('catalogue build follows Google redirect server-side, and closes when Form is invalid', async () => {
  const f = setup();
  const live = await callScript(f.env, 'catalogue', {}, f.fetcher);
  assert.equal(live.data.ready, true);
  assert.equal(live.data.products[1].skus[0].paise, 24950);
  assert.equal(live.data.products[1].image, 'assets/blue%20tote.webp');
  f.state.choices.push('broken');
  const paused = await callScript(f.env, 'catalogue', {}, f.fetcher);
  assert.equal(paused.data.ready, false);
  assert.equal(f.orders.rows.length, 0);
  await assert.rejects(
    callScript(
      f.env,
      'catalogue',
      {},
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://accounts.google.com/login' }
        })
    ),
    /Anyone/
  );
});

test('background catalogue check invokes deploy hook on edits without building repeatedly', () => {
  const f = setup();
  f.script.installCatalogueSync();
  f.script.installCatalogueSync();
  assert.equal(f.triggers.length, 1);
  assert.equal(f.state.redeploys, 0);
  f.state.choices.push('NOTE | Notebook | Orange | One size | 120');
  f.script.publishCatalogueIfChanged();
  f.script.publishCatalogueIfChanged();
  assert.equal(f.state.redeploys, 1);
  const next = f.catalogue();
  f.state.deployed = next;
  f.script.publishCatalogueIfChanged();
  assert.equal(f.state.redeploys, 1);
  f.state.open = false;
  f.script.publishCatalogueIfChanged();
  assert.equal(f.state.redeploys, 2);
});
