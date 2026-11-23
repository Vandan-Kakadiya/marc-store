import { createHash } from 'node:crypto';
import {
  CheckoutError,
  fail,
  json,
  orderPattern,
  proofLimit,
  readBytes,
  readJSON,
  requiredText,
  seal,
  sha256Pattern,
  siteURL,
  skuPattern,
  unseal
} from './common.js';
import { loginReady, getUser, logout } from './auth.js';
import { createAccountStore } from './account-store.js';
import { readBag, writeBag } from './bag.js';
import { callScript, scriptEndpoint } from './script-client.js';
import { validateCatalogue } from './catalogue.js';
import {
  enqueueOrder, queueKey, queuedNumber, queuedStatus, queueStore, rememberQueuedNumber
} from './order-queue.js';
import { upiOrder, upiQr } from './upi.js';

const groups = [
  'PGPM 2026-28',
  'PGPM 2025-27',
  'PGPM HR 2026-28',
  'PGPM HR 2025-27',
  'Staff',
  'Other'
];
const quotePurpose = 'order quote';
const receiptPurpose = 'order receipt';
const quoteMax = 210000;
const orderNumberPattern = /^MARC_(?:[0-9]{6,7}|STAFF|OTHER)_[1-9][0-9]*$/;
const proofTypes = ['image/png', 'image/jpeg', 'image/webp'];
const bankTransfer = 'Bank transfer (NEFT / IMPS / RTGS)';
const paymentMethods = ['GPay', 'PhonePe', 'Paytm', 'CRED', bankTransfer, 'Others'];
function storageReady(env) {
  return !!(
    scriptEndpoint(env.MARC_SCRIPT_URL) &&
    sha256Pattern.test(env.MARC_SCRIPT_SECRET || '')
  );
}
function queueEnabled(env) {
  return env.MARC_ORDER_QUEUE_ENABLED === '1';
}
function queuedResponse(quote, number) {
  return json({
    id: quote.id, total: quote.total, lines: quote.lines, status: 'processing',
    ...(orderNumberPattern.test(number || '') ? { number } : {})
  }, 202);
}
async function reserveQueuedNumber(store, key, env, fetcher, order, bytes) {
  try {
    const previous = await queuedNumber(store, key);
    if (orderNumberPattern.test(previous)) return previous;
    const proofHash = createHash('sha256').update(bytes).digest('hex');
    const reserved = await callScript(env, 'reserveQueuedOrder', { order, proofHash }, fetcher, 18000);
    const number = reserved.ok ? reserved.data?.number : '';
    if (!orderNumberPattern.test(number || '')) return '';
    // Another request may already have saved the same reservation.
    await rememberQueuedNumber(store, key, number).catch(() => {});
    return number;
  } catch {
    // The proof is durable. The worker can reserve the same number and finish.
    return '';
  }
}
function contactInfo(data, buyer) {
  const name = requiredText(data?.name, 120, 'your full name');
  const phone = data?.phone;
  if (typeof phone !== 'string' || !/^[1-9][0-9]{9}$/.test(phone))
    fail(400, 'Enter a 10-digit mobile number starting with 1 through 9.');
  if (!groups.includes(data.affiliation))
    fail(400, 'Choose your programme or affiliation.');
  const student = groups.slice(0, 4).includes(data.affiliation);
  const roll = student ? data.roll : '';
  if (student && (typeof roll !== 'string' || !/^[0-9]{7}$/.test(roll)))
    fail(400, 'Enter a roll number with exactly 7 digits.');
  return {
    name,
    email: buyer.email,
    phone,
    affiliation: data.affiliation,
    roll
  };
}
function printDetails(item, fields) {
  if (!fields.length || item.print === undefined) return;
  if (!Array.isArray(item.print) || item.print.length !== item.qty)
    fail(400, 'Check that the print details match the quantity.');
  const units = item.print.map((entry) => {
    const unit = {};
    const name = entry?.name;
    if (fields.includes('name') && name !== undefined &&
        (typeof name !== 'string' || name.trim()))
      unit.name = requiredText(name, 80, 'the name to print');
    const number = entry?.number;
    if (fields.includes('number') && number !== undefined && number !== '') {
      if (typeof number !== 'string' || !/^[0-9]{1,4}$/.test(number))
        fail(400, 'Enter a number to print from 0 to 9999.');
      unit.number = number;
    }
    return unit;
  });
  if (units.some((unit) => unit.name || unit.number)) return units;
}
function lineItems(catalogue, input) {
  if (
    !Array.isArray(input) ||
    !input.length ||
    input.length > catalogue.maxItems
  )
    fail(400, 'Choose items within the current order limit.');
  const variants = new Map(
    catalogue.products.flatMap((p) =>
      p.skus.map((s) => [
        s.sku,
        {
          sku: s.sku,
          name: p.name,
          colour: p.colour,
          size: s.size,
          paise: s.paise,
          printFields: s.printFields ?? []
        }
      ])
    )
  );
  const seen = new Set();
  let units = 0;
  const lines = input.map((li) => {
    if (
      !li ||
      typeof li.sku !== 'string' ||
      !skuPattern.test(li.sku) ||
      seen.has(li.sku) ||
      !Number.isInteger(li.qty) ||
      li.qty < 1 ||
      li.qty > catalogue.maxItems
    )
      fail(400, 'Check the products and quantities in your order.');
    const item = variants.get(li.sku);
    if (!item)
      fail(409, 'An option is no longer available. Return to the shop.');
    seen.add(li.sku);
    units += li.qty;
    const { printFields, ...line } = item;
    const print = printDetails(li, printFields);
    return { ...line, qty: li.qty, ...(print ? { print } : {}) };
  });
  if (units > catalogue.maxItems)
    fail(400, 'The order exceeds the current item limit.');
  return lines.sort((a, b) => a.sku.localeCompare(b.sku));
}
async function getCatalogue(origin, fetcher) {
  const url = new URL('/catalogue.json', origin);
  const response = await fetcher(url.href, {
    redirect: 'error',
    signal: AbortSignal.timeout(7000)
  });
  if (!response.ok) fail(503, 'The catalogue is temporarily unavailable.');
  return validateCatalogue(await response.json());
}
function paymentForQuote(payment, quote, env) {
  const upi = upiOrder(payment, quote, env.MARC_SESSION_KEY);
  const accountNumber = (env.MARC_BANK_ACCOUNT_NUMBER || '').trim();
  const ifsc = (env.MARC_BANK_IFSC || '').trim().toUpperCase();
  if (
    !/^[0-9]{6,34}$/.test(accountNumber) ||
    !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)
  )
    return { ...payment, ...upi };
  return { ...payment, ...upi, bank: { accountNumber, ifsc } };
}
function quoteView(quote) {
  const { payment } = quote;
  return {
    id: quote.id,
    total: quote.total,
    lines: quote.lines,
    payment: {
      ...payment,
      ...(payment.upiLink ? { orderQr: upiQr(payment.upiLink) } : {})
    },
    terms: quote.terms
  };
}
function openQuote(token, env, buyer) {
  const quote =
    typeof token === 'string' &&
    unseal(token, quotePurpose, env.MARC_SESSION_KEY, quoteMax);
  if (!quote)
    fail(409, 'This checkout has expired. Contact MARC if you already paid.');
  if (quote.buyer !== buyer.sub)
    fail(403, 'Sign in with the Google account that started this checkout.');
  return quote;
}
function isProof(bytes, mime) {
  if (mime === 'image/png')
    return bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'image/jpeg')
    return bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
  return (
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  );
}
async function submit(req, env, buyer, fetcher, store) {
  if (!storageReady(env)) fail(503, 'MARC is setting up order storage.');
  const type = req.headers.get('content-type') || '';
  if (!/^multipart\/form-data\s*;/i.test(type))
    fail(415, 'Attach a payment screenshot.');
  const raw = await readBytes(req, proofLimit + 220000);
  let form;
  try {
    form = await new Response(raw, {
      headers: { 'content-type': type }
    }).formData();
  } catch {
    fail(400, 'The screenshot could not be read. Select it again.');
  }
  const quote = openQuote(form.get('quote'), env, buyer),
    proof = form.get('proof'),
    paidWith = form.get('paidWith') ?? '',
    reference = form.get('utr');
  if (
    (quote.requiresPaidWith || paidWith !== '') &&
    !paymentMethods.includes(paidWith)
  )
    fail(400, 'Choose how you paid for this order.');
  const utr = typeof reference === 'string' ? reference.trim().toUpperCase() : '';
  if (paidWith === bankTransfer) {
    if (!quote.payment.bank)
      fail(400, 'Bank transfer is unavailable for this checkout.');
    if (!/^[A-Z0-9]{6,40}$/.test(utr))
      fail(400, 'Enter the UTR from your bank receipt using letters and digits.');
  } else if (!/^[0-9]{12}$/.test(utr)) {
    fail(400, 'Enter the 12-digit UPI transaction ID.');
  }
  if (
    !proof ||
    typeof proof === 'string' ||
    proof.size < 1 ||
    proof.size > proofLimit ||
    !proofTypes.includes(proof.type)
  )
    fail(400, 'Choose a PNG, JPG or WebP screenshot up to 4 MB.');
  const bytes = Buffer.from(await proof.arrayBuffer());
  if (!isProof(bytes, proof.type))
    fail(400, 'The screenshot must be an actual PNG, JPG or WebP file.');

  const order = {
    id: quote.id,
    buyer: quote.buyer,
    contact: quote.contact,
    lines: quote.lines,
    total: quote.total,
    payee: quote.payment.payee,
    ...(quote.collection ? { collection: quote.collection } : {}),
    utr,
    ...(paidWith ? { paidWith } : {}),
    ...(quote.payment.upiReference && paidWith !== bankTransfer
      ? { upiReference: quote.payment.upiReference }
      : {}),
    proof: { mime: proof.type }
  };
  let result;
  if (quote.queued || queueEnabled(env)) {
    if (!env.BLOB_READ_WRITE_TOKEN) fail(503, 'MARC is setting up order storage.');
    const key = queueKey(env, quote);
    try {
      result = await enqueueOrder(store, key, order, bytes);
    } catch (e) {
      if (e instanceof CheckoutError) throw e;
      fail(503, 'We could not confirm the upload yet. Check this order again or retry with the same UTR and screenshot. Pay only once.');
    }
    if (!result.pending) return orderResult(result, quote, env, buyer);
    const number = await reserveQueuedNumber(store, key, env, fetcher, order, bytes);
    return queuedResponse(quote, number);
  }
  try {
    order.proof.base64 = bytes.toString('base64');
    result = await callScript(env, 'placeOrder', order, fetcher);
  } catch {
    fail(
      503,
      'Google has not confirmed the save yet. Retry Place order with the same UTR and screenshot. Pay only once.'
    );
  }
  return orderResult(result, quote, env, buyer);
}

function orderResult(result, quote, env, buyer) {
  if (!result.ok) {
    if (result.code === 'reference_in_use')
      fail(
        409,
        'This transaction ID is already recorded. Check it or contact MARC.'
      );
    if (result.code === 'retry_different')
      fail(409, 'Use the same payment method, UTR and screenshot from your first submission.');
    if (result.code === 'busy')
      fail(
        503,
        'Order storage is busy. Retry with the same UTR and screenshot.'
      );
    if (result.code === 'setup')
      fail(
        503,
        'Order storage needs attention. Contact MARC with your order reference.'
      );
    fail(
      503,
      'Google has not confirmed the save yet. Retry with the same UTR and screenshot.'
    );
  }
  const saved = result.data;
  if (
    !saved ||
    saved.id !== quote.id ||
    !Number.isFinite(Date.parse(saved.submittedAt)) ||
    saved.status !== 'under_review'
  )
    fail(
      503,
      'The save receipt is incomplete. Retry with the same UTR and screenshot.'
    );
  const receipt = {
    id: quote.id,
    number: orderNumberPattern.test(saved.number || '') ? saved.number : quote.id,
    total: quote.total,
    lines: quote.lines,
    submittedAt: saved.submittedAt,
    status: saved.status
  };
  return json({
    ...receipt,
    token: seal(
      { ...receipt, buyer: buyer.sub, expires: Date.now() + 365 * 86400000 },
      receiptPurpose,
      env.MARC_SESSION_KEY
    )
  });
}

function ownReceipts(tokens, env, buyer) {
  if (!Array.isArray(tokens) || tokens.length > 15)
    fail(400, 'Could not read the saved receipts.');
  const visible = [];
  for (const token of tokens) {
    const receipt =
      typeof token === 'string' &&
      unseal(token, receiptPurpose, env.MARC_SESSION_KEY, quoteMax);
    if (receipt && receipt.buyer === buyer.sub) {
      const { id, number, total, lines, submittedAt, status } = receipt;
      visible.push({ id, number: number || id, total, lines, submittedAt, status });
    }
  }
  return visible;
}

async function orderHistory(body, env, buyer, fetcher) {
  if (!storageReady(env)) fail(503, 'MARC is setting up order storage.');
  const orderIds = ownReceipts(body.tokens ?? [], env, buyer).map((r) => r.id);
  let result;
  try {
    result = await callScript(
      env,
      'listOrders',
      { buyer: buyer.sub, email: buyer.googleEmail ? buyer.email : '', orderIds },
      fetcher,
      10000
    );
  } catch {
    fail(503, 'Your orders could not be loaded. Try again.');
  }
  if (!result.ok || !Array.isArray(result.data))
    fail(503, 'Your orders could not be loaded. Try again.');
  return json(result.data);
}

export function createCheckout({
  env, fetcher = fetch, store = queueStore(env), accounts = createAccountStore(env, fetcher)
}) {
  return async (req) => {
    try {
      const url = new URL(req.url),
        origin = siteURL(env.MARC_SITE_URL);
      const action = url.searchParams.get('action') || 'session';
      if (!origin || url.origin !== origin)
        fail(503, 'Open the official MARC store address.');
      if (req.method === 'GET' && action === 'session') {
        const buyer = await getUser(req, env, accounts);
        return json({
          user: buyer ? { name: buyer.name, email: buyer.email } : null,
          sessionRemainingMs: buyer ? Math.max(0, buyer.expires - Date.now()) : 0,
          loginReady: loginReady(env),
          storageReady: storageReady(env) && (!queueEnabled(env) || !!env.BLOB_READ_WRITE_TOKEN)
        });
      }
      if (req.method === 'GET' && action === 'bag') {
        const buyer = await getUser(req, env, accounts);
        if (!buyer) fail(401, 'Sign in with Google to sync your bag.');
        return json(await readBag(accounts, env, buyer));
      }
      if (req.method !== 'POST') fail(405, 'Open checkout to continue.');
      if (req.headers.get('origin') !== origin)
        fail(403, 'Open checkout on the MARC website.');
      if (action === 'logout') return await logout(req, env, accounts);
      const buyer = await getUser(req, env, accounts);
      if (!buyer) fail(401, 'Sign in with Google to continue.');
      if (action === 'place') return await submit(req, env, buyer, fetcher, store);
      const maxJSON =
        action === 'receipts' || action === 'history'
          ? 2600000
          : action === 'resume' || action === 'status'
            ? quoteMax + 128
            : action === 'quote'
              ? 64000
              : 22000;
      const body = await readJSON(req, maxJSON);
      switch (action) {
        case 'bag':
          return json(await writeBag(accounts, env, buyer, body));
        case 'quote': {
          if (!storageReady(env) || (queueEnabled(env) && !env.BLOB_READ_WRITE_TOKEN))
            fail(503, 'MARC is setting up order storage.');
          if (typeof body.id !== 'string' || !orderPattern.test(body.id))
            fail(400, 'Start checkout again from the store.');
          const catalogue = await getCatalogue(origin, fetcher);
          if (!catalogue.ready) fail(409, 'Ordering is currently paused.');
          if (queueEnabled(env) && !catalogue.collection)
            fail(503, 'MARC is preparing the order sheet for this collection.');
          if (catalogue.version !== body.version)
            fail(
              409,
              'The catalogue changed. Review your order before you pay.'
            );
          const contact = contactInfo(body.contact, buyer),
            lines = lineItems(catalogue, body.items);
          const order = {
            id: body.id,
            buyer: buyer.sub,
            total: lines.reduce((n, r) => n + r.qty * r.paise, 0)
          };
          const quote = {
            ...order,
            contact,
            lines,
            ...(catalogue.collection ? { collection: catalogue.collection } : {}),
            ...(queueEnabled(env) ? { queued: true } : {}),
            terms: catalogue.terms,
            payment: paymentForQuote(catalogue.payment, order, env),
            requiresPaidWith: true,
            expires: Date.now() + 7 * 86400000
          };
          const token = seal(quote, quotePurpose, env.MARC_SESSION_KEY);
          if (token.length > quoteMax)
            fail(400, 'This order contains too many details. Split it into smaller orders before paying.');
          return json({ ...quoteView(quote), token });
        }
        case 'resume':
          return json(quoteView(openQuote(body.quote, env, buyer)));
        case 'status': {
          const quote = openQuote(body.quote, env, buyer);
          if (!env.BLOB_READ_WRITE_TOKEN) {
            if (quote.queued) fail(503, 'Order status is temporarily unavailable.');
            return json({ id: quote.id, status: 'not_submitted' });
          }
          const result = await queuedStatus(store, queueKey(env, quote));
          if (!result) return json({ id: quote.id, status: 'not_submitted' });
          if (result.pending) return queuedResponse(quote, result.number);
          if (!result.ok) return json({
            id: quote.id,
            total: quote.total,
            lines: quote.lines,
            status: 'needs_attention',
            message: result.code === 'reference_in_use'
              ? 'This transaction ID is already recorded. Check My orders or contact MARC with this reference.'
              : 'Contact MARC with this reference so the team can check your payment submission.'
          });
          return orderResult(result, quote, env, buyer);
        }
        case 'receipts':
          return json(ownReceipts(body.tokens, env, buyer));
        case 'history':
          return await orderHistory(body, env, buyer, fetcher);
        default:
          fail(404, 'Unknown checkout request.');
      }
    } catch (e) {
      if (e instanceof CheckoutError)
        return json({ error: e.message }, e.status);
      return json(
        {
          error:
            'Checkout is temporarily unavailable. Try again from this page.'
        },
        503
      );
    }
  };
}
