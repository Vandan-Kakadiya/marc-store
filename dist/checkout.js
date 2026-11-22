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
} from './market-core.js?v=10';

const legacyReceiptKey = 'marc-vercel-receipts-v1';
const path = new URL(location.href);
const contactForm = $('contact-form');
const fields = contactForm.elements,
  proof = $('proof-form').elements;
const printLabels = { name: 'Name to print', number: 'Number to print' };
const orderProgress = $('order-progress');
const googleButton = $('google');
const googleProgress = $('google-progress');
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
const ordersMode =
  path.searchParams.get('orders') === '1' || !draft?.items?.length;
let loadCount = 0;
let sessionTimer, sessionEndsAt;
let googleLoaderTimer, googleRetryTimer;

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
function resetGoogleSignIn() {
  if (googleRetryTimer === undefined) return;
  clearTimeout(googleLoaderTimer);
  clearTimeout(googleRetryTimer);
  googleRetryTimer = undefined;
  googleProgress.close();
  googleButton.disabled = false;
}
function startGoogleSignIn() {
  if (googleButton.disabled) return;
  message();
  googleButton.disabled = true;
  googleLoaderTimer = setTimeout(() => googleProgress.showModal(), 150);
  googleRetryTimer = setTimeout(() => {
    resetGoogleSignIn();
    message('Google sign-in is taking longer than expected. Try again.');
    googleButton.focus();
  }, 15000);
  try {
    location.assign('/api/auth/start' + (ordersMode ? '?orders=1' : ''));
  } catch {
    resetGoogleSignIn();
    message('Could not open Google sign-in. Try again.');
    googleButton.focus();
  }
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
  contactForm.reset();
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
    if (fixed && Array.isArray(row.print)) {
      row.print.forEach((entry, index) => {
        const values = [];
        if (entry.name) values.push('Name: ' + entry.name);
        if (entry.number) values.push('Number: ' + entry.number);
        const prefix = item.qty > 1 ? 'Item ' + (index + 1) + ' · ' : '';
        description.append(node('p', 'line-meta print-summary', prefix + values.join(' · ')));
      });
    }
    const listed = row.image ? row : catalogue.skus.find((s) => s.sku === row.sku);
    const photoRow = { ...row, image: listed?.image, imageVariants: listed?.imageVariants };
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
function printableSku(item) {
  if (!Number.isInteger(item.qty) || item.qty < 1 || item.qty > catalogue.limit)
    return null;
  const sku = catalogue.skus.find((row) => row.sku === item.sku);
  return sku?.printFields?.length ? sku : null;
}
function printInputName(sku, index, field) {
  return 'print-' + sku + '-' + index + '-' + field;
}
function renderPrintInputs() {
  const previous = new FormData(contactForm);
  const items = [];
  for (const item of draft.items) {
    const sku = printableSku(item);
    if (!sku) continue;
    for (let index = 0; index < item.qty; index++) {
      const fieldset = node('fieldset', 'print-item');
      const itemLabel = sku.name + ' · ' + sku.colour + ' / ' + sku.size;
      fieldset.append(node(
        'legend', '', itemLabel + (item.qty > 1 ? ' · Item ' + (index + 1) : '')
      ));
      for (const field of sku.printFields) {
        const input = node('input');
        input.name = printInputName(sku.sku, index, field);
        input.required = true;
        input.autocomplete = 'off';
        input.maxLength = field === 'number' ? 4 : 80;
        if (field === 'number') {
          input.inputMode = 'numeric';
          input.pattern = '[0-9]{1,4}';
          input.placeholder = '0 to 9999';
          input.title = 'Enter a whole number from 0 to 9999';
        } else {
          input.pattern = '.*\\S.*';
        }
        input.value = previous.get(input.name) ?? '';
        const label = node('label', '', printLabels[field]);
        label.append(input);
        fieldset.append(label);
      }
      items.push(fieldset);
    }
  }
  $('print-items').replaceChildren(...items);
  $('print-options').hidden = !items.length;
}
function checkoutItems() {
  const values = new FormData(contactForm);
  return draft.items.map((item) => {
    const sku = printableSku(item);
    if (!sku) return item;
    const print = Array.from({ length: item.qty }, (_, index) =>
      Object.fromEntries(sku.printFields.map((field) => [
        field, values.get(printInputName(sku.sku, index, field))
      ]))
    );
    return { ...item, print };
  });
}
function openContact() {
  show('contact');
  fields.email.value = user.email;
  if (!fields.name.value) fields.name.value = user.name || '';
  updateRoll();
  renderPrintInputs();
}
function updateReferenceField() {
  const bank = proof.paidWith.value === $('bank-payment-method').value;
  $('reference-label').textContent = bank
    ? 'Bank transfer UTR'
    : 'UPI transaction ID (UTR)';
  proof.utr.inputMode = bank ? 'text' : 'numeric';
  proof.utr.minLength = bank ? 6 : 12;
  proof.utr.maxLength = bank ? 40 : 12;
  proof.utr.pattern = bank ? '[A-Za-z0-9]{6,40}' : '[0-9]{12}';
  proof.utr.placeholder = bank
    ? 'Reference from your bank receipt'
    : '12-digit reference';
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

  const bank = record.payment.bank;
  const bankDetails = $('bank-details');
  bankDetails.hidden = !bank;
  if (!bank) bankDetails.open = false;
  $('bank-name').textContent = bank ? record.payment.payee : '';
  $('bank-account-number').textContent = bank?.accountNumber ?? '';
  $('bank-ifsc').textContent = bank?.ifsc ?? '';
  const bankOption = $('bank-payment-method');
  bankOption.hidden = !bank;
  bankOption.disabled = !bank;
  proof.paidWith.value = draft.paidWith || '';
  proof.paidWith.disabled = !!draft.sent;
  $('paid-with-label').hidden = Boolean(draft.sent && !draft.paidWith);
  updateReferenceField();

  $('cancel-unpaid').hidden = !!draft.sent;
  $('proof-tip').textContent = draft.sent
    ? 'Retry with the same UTR and screenshot. Pay only once.'
    : 'After paying, select your payment method, enter the reference and attach your screenshot.';
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
    : 'Your order and screenshot were saved. MARC will verify your payment.';
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
proof.paidWith.onchange = updateReferenceField;
$('retry-checkout').onclick = boot;
window.addEventListener('pageshow', checkSessionExpiry);
window.addEventListener('pagehide', resetGoogleSignIn);
document.addEventListener('visibilitychange', checkSessionExpiry);
orderProgress.addEventListener('cancel', (event) => event.preventDefault());
googleProgress.addEventListener('cancel', (event) => event.preventDefault());
googleButton.onclick = startGoogleSignIn;
for (const id of ['switch-account', 'switch-order-account']) {
  $(id).onclick = async () => {
    try {
      await post('logout');
      contactForm.reset();
      location.assign('checkout.html' + (ordersMode ? '?orders=1' : ''));
    } catch (e) {
      message(e.message, true);
    }
  };
}
contactForm.onsubmit = async (e) => {
  e.preventDefault();
  if (!user || !draft || $('continue-payment').disabled) return;
  const turn = loadCount;
  $('continue-payment').disabled = true;
  message('Confirming the total…');
  try {
    const data = await post('quote', {
      id: draft.id,
      version: catalogue.version,
      paidWithSelection: true,
      items: checkoutItems(),
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
        renderPrintInputs();
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
  const paidWith = draft.paidWith || proof.paidWith.value;
  payload.set('quote', draft.quote);
  payload.set('utr', proof.utr.value.trim());
  payload.set('proof', image, image.name);
  if (paidWith) payload.set('paidWith', paidWith);
  const pending = { ...draft, sent: true, ...(paidWith ? { paidWith } : {}) };
  if (!save(sessionStorage, DRAFT, pending)) {
    message(
      'Allow browser storage so you can recover this order if the connection drops.'
    );
    return;
  }
  draft = pending;
  proof.paidWith.disabled = true;
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

if (ordersMode) {
  document.documentElement.classList.add('orders-page');
  document.title = 'My orders | MARC Store';
  $('receipt-items').append($('order-items'));
  showSignIn();
}
summary(ordersMode ? [] : draft.items);
boot();
