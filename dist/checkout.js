import {
  $,
  DRAFT,
  affiliations,
  api,
  btn,
  cachedCatalogue,
  configured,
  finishBag,
  liveCatalogue,
  money,
  node,
  picture,
  post,
  read,
  save
} from './market-core.js?v=5';

const legacyReceiptKey = 'marc-vercel-receipts-v1';
const path = new URL(location.href);
const fields = $('contact-form').elements,
  proof = $('proof-form').elements;
const orderProgress = $('order-progress');
const zones = ['login', 'contact', 'payment', 'receipt', 'orders'];
const indiaTime = new Intl.DateTimeFormat('en-IN', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Kolkata'
});
let draft = read(sessionStorage, DRAFT, null),
  catalogue = cachedCatalogue(),
  user,
  order;
let ordersMode =
  path.searchParams.get('orders') === '1' || !draft?.items?.length;
let loadCount = 0;
let sessionTimer, sessionEndsAt;

function show(zone) {
  for (const id of zones) $(id).hidden = id !== zone;
}
function message(text = '', retry = false) {
  $('checkout-status').textContent = text;
  $('retry-checkout').hidden = !retry;
}
function showSignIn() {
  show('login');
  $('login').querySelector('h2').textContent = ordersMode
    ? 'Sign in to view your orders'
    : 'Sign in to checkout';
}
function expireSession(
  text = 'Your 20-minute session ended. Sign in with Google to continue.'
) {
  ++loadCount;
  clearTimeout(sessionTimer);
  user = null;
  order = null;
  sessionEndsAt = 0;
  orderProgress.close();
  $('continue-payment').disabled = true;
  $('google').disabled = false;
  $('contact-form').reset();
  $('proof-form').reset();
  $('past-orders').replaceChildren();
  $('order-number').textContent = '';
  $('order-time').textContent = '';
  $('order-time').removeAttribute('datetime');
  summary([]);
  showSignIn();
  message(text);
}
function checkSessionExpiry() {
  if (user && sessionEndsAt && Date.now() >= sessionEndsAt) expireSession();
}
function setOrderProgress(percent) {
  const ring = $('order-progress-ring');
  ring.style.setProperty('--order-progress', percent + '%');
  ring.setAttribute('aria-valuenow', String(percent));
  $('order-progress-percent').textContent = percent + '%';
}
function startOrderProgress() {
  const started = performance.now();
  let percent = 1;
  setOrderProgress(percent);
  orderProgress.showModal();
  return setInterval(() => {
    // Estimate progress while the server prepares its save confirmation.
    const elapsed = performance.now() - started;
    const next = 1 + Math.round(94 * (1 - Math.exp(-elapsed / 2400)));
    if (percent !== next) {
      percent = next;
      setOrderProgress(percent);
    }
  }, 80);
}
function summary(items, fixed = false) {
  const target = $('summary-lines');
  target.replaceChildren();
  let total = 0,
    complete = true;
  for (const item of items) {
    const row = fixed ? item : catalogue.skus.find((s) => s.sku === item.sku);
    if (!row) {
      target.append(node('p', 'status', item.sku + ' · Checking availability'));
      complete = false;
      continue;
    }
    const line = node('div', 'sum-item'),
      description = node('div');
    description.append(
      node('strong', '', row.name),
      node(
        'p',
        'line-meta',
        row.colour + ' / ' + row.size + ' · Qty ' + item.qty
      )
    );
    const photoRow = row.image
      ? row
      : { ...row, image: catalogue.skus.find((s) => s.sku === row.sku)?.image };
    line.append(
      picture(photoRow, 'thumb'),
      description,
      node('strong', '', money(row.paise * item.qty))
    );
    target.append(line);
    total += row.paise * item.qty;
  }
  $('summary-total').textContent =
    complete && items.length ? money(total) : '—';
}
function updateRoll() {
  const showRoll = affiliations.slice(0, 4).includes(fields.affiliation.value);
  $('roll-label').hidden = !showRoll;
  fields.roll.disabled = !showRoll;
  fields.roll.required = showRoll;
  if (!showRoll) fields.roll.value = '';
}
function openContact() {
  show('contact');
  fields.email.value = user.email;
  if (!fields.name.value) fields.name.value = user.name || '';
  updateRoll();
}
function openPayment(record) {
  order = record;
  show('payment');
  summary(record.lines, true);
  $('summary-total').textContent = money(record.total);
  $('payee').textContent = record.payment.payee;
  $('pay-amount').textContent = money(record.total);
  $('upi').textContent = record.payment.upi;
  const qr = $('qr');
  qr.onerror = () =>
    message(
      'The payment QR did not load. Check with MARC before paying.',
      true
    );
  qr.src = record.payment.qr;
  $('qr-link').href = record.payment.qr;
  $('cancel-unpaid').hidden = !!draft.sent;
  $('proof-tip').textContent = draft.sent
    ? 'Retry with the same UTR and screenshot. Pay only once.'
    : 'After paying, enter the transaction ID and attach your screenshot.';
}
function openReceipt(entry) {
  show('receipt');
  summary(entry.lines, true);
  if (!entry.lines.length && entry.items) {
    const rows = entry.items
      .split('\n')
      .map((item) => node('p', 'line-meta', item));
    $('summary-lines').replaceChildren(...rows);
  }
  $('summary-total').textContent = money(entry.total);
  $('receipt-status').textContent = entry.paymentStatus
    ? 'Payment status · ' + entry.paymentStatus
    : 'Your order and screenshot were saved. MARC will verify the UPI payment.';
  $('order-number').textContent = entry.number || entry.id;
  $('back-to-orders').hidden = !ordersMode;
  $('order-time').dateTime = entry.submittedAt;
  $('order-time').textContent =
    indiaTime.format(new Date(entry.submittedAt)) + ' IST';
  $('receipt').querySelector('h2').focus({ preventScroll: true });
}
async function myOrders(turn) {
  show('orders');
  summary([]);
  const out = $('past-orders'),
    history = read(localStorage, legacyReceiptKey, []);
  out.replaceChildren();
  message('Loading your orders…');
  const entries = Array.isArray(history) ? history : [];
  const tokens = entries.slice(0, 12).map((e) => e?.token).filter(Boolean);
  if (draft?.receipt) tokens.push(draft.receipt);
  const receipts = await post('history', { tokens });
  if (turn !== loadCount) return;
  message();
  if (draft?.quote && !draft.receipt)
    out.append(
      btn('Resume checkout', 'action navy', () =>
        location.assign('checkout.html')
      )
    );
  if (!receipts.length)
    out.append(
      node(
        'p',
        'card-meta',
        'No orders found for this Google account.'
      )
    );
  for (const entry of receipts) {
    const row = node('div', 'past-order');
    row.append(
      node(
        'strong',
        '',
        money(entry.total) +
          ' · ' +
          indiaTime.format(new Date(entry.submittedAt))
      ),
      node('p', '', entry.number),
      node('p', 'line-meta', entry.paymentStatus),
      btn('View receipt', 'text-btn', () => openReceipt(entry))
    );
    out.append(row);
  }
}
async function boot() {
  const turn = ++loadCount;
  const requestedAt = Date.now();
  $('google').disabled = true;
  $('continue-payment').disabled = true;
  message();
  if (!configured) {
    show('login');
    message('Open the deployed MARC store to continue.');
    return;
  }
  try {
    const [info, next] = await Promise.all([
      api('session'),
      ordersMode || draft?.quote || draft?.receipt
        ? Promise.resolve(null)
        : liveCatalogue().then(
            (value) => ({ value }),
            (error) => ({ error })
          )
    ]);
    if (turn !== loadCount) return;
    clearTimeout(sessionTimer);
    user = info.user;
    $('google').disabled = !info.loginReady;
    if (!user) {
      sessionEndsAt = 0;
      showSignIn();
      if (!info.loginReady) message('MARC is setting up Google sign-in.');
      return;
    }
    sessionEndsAt = requestedAt + info.sessionRemainingMs;
    const timeLeft = sessionEndsAt - Date.now();
    if (!Number.isFinite(timeLeft) || timeLeft <= 0) {
      expireSession();
      return;
    }
    sessionTimer = setTimeout(expireSession, timeLeft);
    if (ordersMode) {
      await myOrders(turn);
      return;
    }
    if (draft.receipt) {
      const [entry] = await post('receipts', { tokens: [draft.receipt] });
      if (turn !== loadCount) return;
      if (entry) openReceipt(entry);
      else {
        show('orders');
        $('past-orders').textContent =
          'Sign in with the Google account used for this order.';
      }
      return;
    }
    if (draft.quote) {
      const record = await post('resume', { quote: draft.quote });
      if (turn === loadCount) openPayment(record);
      return;
    }
    if (next.value) catalogue = next.value;
    openContact();
    summary(draft.items);
    const available = draft.items.every((item) =>
      catalogue.skus.some((s) => s.sku === item.sku)
    );
    const canPay =
      info.storageReady && !next.error && catalogue.open && available;
    $('continue-payment').disabled = !canPay;
    if (next.error) throw next.error;
    if (!info.storageReady) message('MARC is setting up order storage.');
    else if (!catalogue.open)
      message(
        'Ordering is paused. Please check back after MARC opens the store.',
        true
      );
    else if (!available)
      message(
        'An option is unavailable. Return to the shop to update the bag.'
      );
  } catch (e) {
    if (turn !== loadCount) return;
    if (e.status === 401) {
      expireSession();
      return;
    }
    message(e.message, true);
  }
}
for (const role of affiliations) fields.affiliation.add(new Option(role, role));
fields.affiliation.onchange = updateRoll;
$('retry-checkout').onclick = boot;
window.addEventListener('pageshow', checkSessionExpiry);
document.addEventListener('visibilitychange', checkSessionExpiry);
orderProgress.addEventListener('cancel', (event) => event.preventDefault());
$('google').onclick = () =>
  location.assign('/api/auth/start' + (ordersMode ? '?orders=1' : ''));
for (const id of ['switch-account', 'switch-order-account']) {
  $(id).onclick = async () => {
    try {
      await post('logout');
      $('contact-form').reset();
      location.assign('checkout.html' + (ordersMode ? '?orders=1' : ''));
    } catch (e) {
      message(e.message, true);
    }
  };
}
$('contact-form').onsubmit = async (e) => {
  e.preventDefault();
  if (!user || !draft || $('continue-payment').disabled) return;
  const turn = loadCount;
  $('continue-payment').disabled = true;
  message('Confirming the total…');
  try {
    const data = await post('quote', {
      id: draft.id,
      version: catalogue.version,
      items: draft.items,
      contact: {
        name: fields.name.value,
        phone: fields.phone.value,
        affiliation: fields.affiliation.value,
        roll: fields.roll.value
      }
    });
    if (turn !== loadCount) return;
    const pending = { ...draft, quote: data.token };
    if (!save(sessionStorage, DRAFT, pending))
      throw Error('Allow browser storage before continuing to payment.');
    draft = pending;
    message();
    openPayment(data);
  } catch (e) {
    if (turn !== loadCount) return;
    if (e.status === 401) {
      expireSession();
      return;
    }
    if (e.status === 409) {
      try {
        catalogue = await liveCatalogue();
        if (turn !== loadCount) return;
        summary(draft.items);
      } catch {}
    }
    message(e.message, true);
  } finally {
    if (turn === loadCount && user)
      $('continue-payment').disabled =
        !catalogue.open ||
        !draft.items.every((item) =>
          catalogue.skus.some((s) => s.sku === item.sku)
        );
  }
};
$('cancel-unpaid').onclick = () => {
  if (
    !draft.sent &&
    confirm('Cancel this checkout only if you have not paid. Continue?')
  ) {
    sessionStorage.removeItem(DRAFT);
    location.assign('./#shop');
  }
};
$('proof-form').onsubmit = async (e) => {
  e.preventDefault();
  if (!user || !order || !draft?.quote || $('submit-proof').disabled) return;
  const turn = loadCount;
  const image = proof.proof.files[0];
  if (
    !image ||
    !['image/png', 'image/jpeg', 'image/webp'].includes(image.type) ||
    image.size > 4 * 1024 * 1024
  ) {
    message('Choose a PNG, JPG or WebP screenshot up to 4 MB.');
    return;
  }
  const payload = new FormData();
  payload.set('quote', draft.quote);
  payload.set('utr', proof.utr.value.trim());
  payload.set('proof', image, image.name);
  const pending = { ...draft, sent: true };
  if (!save(sessionStorage, DRAFT, pending)) {
    message(
      'Allow browser storage so you can recover this order if the connection drops.'
    );
    return;
  }
  draft = pending;
  $('cancel-unpaid').hidden = true;
  $('submit-proof').disabled = true;
  message();
  let progressTimer;
  try {
    progressTimer = startOrderProgress();
    const saved = await api('place', {
      method: 'POST',
      body: payload,
      signal: AbortSignal.timeout(65000)
    });
    if (saved.id !== pending.id || !saved.token)
      throw Error('The order save could not be confirmed.');
    const completed = { ...pending, receipt: saved.token };
    const savedDraft = save(sessionStorage, DRAFT, completed);
    draft = completed;
    clearInterval(progressTimer);
    if (turn === loadCount) {
      setOrderProgress(100);
      await new Promise((resolve) => setTimeout(resolve, 350));
      if (turn === loadCount) {
        orderProgress.close();
        openReceipt(saved);
      }
    }
    proof.proof.value = '';
    try {
      await finishBag(completed);
    } catch {
      if (turn === loadCount)
        message('Your order was saved. Your browser could not update the bag.');
    }
    if (turn === loadCount && !savedDraft)
      message('Your order was saved. Keep a copy of your order reference.');
  } catch (e) {
    if (turn !== loadCount) return;
    if (e.status === 401) {
      expireSession(
        'Sign in with the same Google account, then retry using the same UTR and screenshot.'
      );
    } else {
      message(e.message + ' Order reference ' + pending.id);
    }
  } finally {
    clearInterval(progressTimer);
    orderProgress.close();
    $('submit-proof').disabled = false;
  }
};

summary(ordersMode ? [] : draft.items);
boot();
