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
import { callScript, scriptEndpoint } from './script-client.js';
import { validateCatalogue } from './catalogue.js';

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
function storageReady(env) {
  return !!(
    scriptEndpoint(env.MARC_SCRIPT_URL) &&
    sha256Pattern.test(env.MARC_SCRIPT_SECRET || '')
  );
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
          paise: s.paise
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
    return { ...item, qty: li.qty };
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
function quoteView(quote) {
  return {
    id: quote.id,
    total: quote.total,
    lines: quote.lines,
    payment: quote.payment,
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
async function submit(req, env, buyer, fetcher) {
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
    utr = form.get('utr');
  if (typeof utr !== 'string' || !/^\d{12}$/.test(utr))
    fail(400, 'Enter the 12-digit UPI transaction ID.');
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
    utr,
    proof: { mime: proof.type, base64: bytes.toString('base64') }
  };
  let result;
  try {
    result = await callScript(env, 'placeOrder', order, fetcher);
  } catch {
    fail(
      503,
      'Google has not confirmed the save yet. Retry Place order with the same UTR and screenshot. Pay only once.'
    );
  }
  if (!result.ok) {
    if (result.code === 'reference_in_use')
      fail(
        409,
        'This transaction ID is already recorded. Check it or contact MARC.'
      );
    if (result.code === 'retry_different')
      fail(409, 'Use the same UTR and screenshot from your first submission.');
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

export function createCheckout({ env, fetcher = fetch }) {
  return async (req) => {
    try {
      const url = new URL(req.url),
        origin = siteURL(env.MARC_SITE_URL);
      const action = url.searchParams.get('action') || 'session';
      if (!origin || url.origin !== origin)
        fail(503, 'Open the official MARC store address.');
      if (req.method === 'GET' && action === 'session') {
        const buyer = getUser(req, env);
        return json({
          user: buyer ? { name: buyer.name, email: buyer.email } : null,
          sessionRemainingMs: buyer ? Math.max(0, buyer.expires - Date.now()) : 0,
          loginReady: loginReady(env),
          storageReady: storageReady(env)
        });
      }
      if (req.method !== 'POST') fail(405, 'Open checkout to continue.');
      if (req.headers.get('origin') !== origin)
        fail(403, 'Open checkout on the MARC website.');
      if (action === 'logout') return logout();
      const buyer = getUser(req, env);
      if (!buyer) fail(401, 'Sign in with Google to continue.');
      if (action === 'place') return await submit(req, env, buyer, fetcher);
      const maxJSON =
        action === 'receipts' || action === 'history'
          ? 2600000
          : action === 'resume'
            ? quoteMax + 128
            : 22000;
      const body = await readJSON(req, maxJSON);
      switch (action) {
        case 'quote': {
          if (!storageReady(env))
            fail(503, 'MARC is setting up order storage.');
          if (typeof body.id !== 'string' || !orderPattern.test(body.id))
            fail(400, 'Start checkout again from the store.');
          const catalogue = await getCatalogue(origin, fetcher);
          if (!catalogue.ready) fail(409, 'Ordering is currently paused.');
          if (catalogue.version !== body.version)
            fail(
              409,
              'The catalogue changed. Review your order before you pay.'
            );
          const contact = contactInfo(body.contact, buyer),
            lines = lineItems(catalogue, body.items);
          const quote = {
            id: body.id,
            buyer: buyer.sub,
            contact,
            lines,
            total: lines.reduce((n, r) => n + r.qty * r.paise, 0),
            terms: catalogue.terms,
            payment: catalogue.payment,
            expires: Date.now() + 7 * 86400000
          };
          return json({
            ...quoteView(quote),
            token: seal(quote, quotePurpose, env.MARC_SESSION_KEY)
          });
        }
        case 'resume':
          return json(quoteView(openQuote(body.quote, env, buyer)));
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
