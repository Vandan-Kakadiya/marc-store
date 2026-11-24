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
  resetAccountBag,
  save,
  syncBag
} from './market-core.js?v=14';

const legacyReceiptKey = 'marc-vercel-receipts-v1';
const path = new URL(location.href);
const contactForm = $('contact-form');
const fields = contactForm.elements,
  proof = $('proof-form').elements;
const printLabels = {
  name: 'Name to print (optional)',
  number: 'Number to print (optional)'
};
const orderProgress = $('order-progress');
const googleButton = $('google');
const googleProgress = $('google-progress');
const zones = ['login', 'contact', 'payment', 'pending-order', 'receipt', 'orders'];
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
let sessionTimer, sessionEndsAt, sessionCheckTimer, checkingSession = false;
let googleLoaderTimer, googleRetryTimer;
let statusTimer;

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
  text = 'Your MARC session ended. Sign in with Google to continue.'
) {
  ++loadCount;
  clearTimeout(sessionTimer);
  clearTimeout(sessionCheckTimer);
  clearTimeout(statusTimer);
  resetAccountBag();
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
  $('pending-reference').textContent = '';
  $('recovery-reference').textContent = '';
  $('order-time').textContent = '';
  $('order-time').removeAttribute('datetime');
  summary([]);
  showSignIn();
  message(text);
}
function scheduleSessionCheck() {
  clearTimeout(sessionCheckTimer);
  sessionCheckTimer = setTimeout(checkSession, 30000);
}
async function checkSession() {
  if (!user) return;
  if (Date.now() >= sessionEndsAt) {
    expireSession();
    return;
  }
  if (document.hidden || checkingSession) return;
  const turn = loadCount;
  checkingSession = true;
  try {
    const info = await api('session');
    if (turn === loadCount && info.user?.email !== user.email)
      expireSession('This MARC session ended. Sign in with Google to continue.');
  } catch {
    // A temporary connection problem does not end a session.
  } finally {
    checkingSession = false;
    if (user && !document.hidden) scheduleSessionCheck();
  }
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
        if (!values.length) return;
        const prefix = item.qty > 1 ? 'Item ' + (index + 1) + ' · ' : '';
        description.append(
          node('p', 'line-meta print-summary', prefix + values.join(' · '))
        );
      });
    }
    const listed = row.image ? row : catalogue.skus.find((s) => s.sku === row.sku);
    const photoRow = {
      ...row,
      image: listed?.image,
      imageVariants: listed?.imageVariants
    };
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
      fieldset.append(
        node('legend', '', itemLabel + (item.qty > 1 ? ' · Item ' + (index + 1) : ''))
      );
      for (const field of sku.printFields) {
        const input = node('input');
        input.name = printInputName(sku.sku, index, field);
        input.autocomplete = 'off';
        input.maxLength = field === 'number' ? 4 : 80;
        if (field === 'number') {
          input.inputMode = 'numeric';
          input.pattern = '[0-9]{1,4}';
          input.placeholder = '0 to 9999';
          input.title = 'Enter a whole number from 0 to 9999';
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
        field, values.get(printInputName(sku.sku, index, field)) ?? ''
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
function showUpiMethods(payment, amount) {
  const link = payment.upiLink?.startsWith('upi://pay?') ? payment.upiLink : '';
  const android = navigator.userAgentData?.platform === 'Android' ||
    /Android/i.test(navigator.userAgent);
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const openApps = !!link && (android || ios);
  const androidIntent = !!link && android && /Chrome\//.test(navigator.userAgent);
  const pay = $('pay-with-upi');
  $('upi-app-payment').hidden = !openApps;
  $('upi-shortcuts').hidden = !androidIntent;
  if (openApps) {
    pay.href = ios ? link.replace('upi://pay?', 'gpay://upi/pay?') : link;
    pay.textContent = 'Pay ' + amount + (ios ? ' with Google Pay' : ' with a UPI app');
  }
  if (androidIntent) {
    const fallback = encodeURIComponent(
      new URL('/checkout.html#payment-qr', location.origin).href
    );
    const intent = link.replace('upi://', 'intent://') + '#Intent;scheme=upi;';
    const end = 'S.browser_fallback_url=' + fallback + ';end';
    pay.href = intent + end;
    $('upi-gpay').href = intent + 'package=com.google.android.apps.nbu.paisa.user;' + end;
    $('upi-phonepe').href = intent + 'package=com.phonepe.app;' + end;
    $('upi-paytm').href = intent + 'package=net.one97.paytm;' + end;
  }
  const qr = $('qr');
  const qrLink = $('qr-link');
  const orderQr = /^data:image\/(png|gif);base64,/.test(payment.orderQr || '')
    ? payment.orderQr
    : '';
  function displayQr(generated) {
    const source = generated ? orderQr : payment.qr;
    $('qr-help').textContent = generated
      ? 'Scan with your phone’s UPI app. The amount and order reference are filled in for you.'
      : 'Scan with your phone’s UPI app and enter the exact order amount shown above.';
    qrLink.href = source;
    qrLink.textContent = generated ? 'Save QR image' : 'Open QR image ↗';
    if (generated) {
      qrLink.download = orderQr.startsWith('data:image/png')
        ? 'marc-payment-qr.png'
        : 'marc-payment-qr.gif';
      qrLink.removeAttribute('target');
    } else {
      qrLink.removeAttribute('download');
      qrLink.target = '_blank';
    }
    qr.src = source;
  }
  qr.onerror = () => {
    if (qr.getAttribute('src') === orderQr) displayQr(false);
    else message('The payment QR did not load. Check with MARC before paying.', true);
  };
  displayQr(!!orderQr);
  $('payment-qr').open = !openApps || location.hash === '#payment-qr';
  $('qr-gallery-help').hidden = !(android || ios);
  $('upi-id').hidden = !/^[a-z0-9][a-z0-9._-]*@[a-z][a-z0-9]+$/i.test(payment.upi);
  $('upi').textContent = payment.upi;
  $('upi-copy-status').textContent = '';
}
function openPayment(record) {
  order = record;
  show('payment');
  summary(record.lines, true);
  const amount = money(record.total);
  $('summary-total').textContent = amount;
  $('payee').textContent = record.payment.payee;
  $('pay-amount').textContent = amount;
  $('payment-methods').hidden = !!draft.sent;
  if (!draft.sent) showUpiMethods(record.payment, amount);

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
  proof.utr.value ||= draft.utr || '';
  proof.paidWith.value = draft.paidWith || '';
  proof.paidWith.disabled = !!draft.sent;
  $('paid-with-label').hidden = Boolean(draft.sent && !draft.paidWith);
  updateReferenceField();

  $('cancel-unpaid').hidden = !!draft.sent;
  $('submit-proof-label').textContent = draft.sent ? 'Retry upload' : 'Place order';
  $('upload-recovery').hidden = !draft.sent;
  $('recovery-reference').textContent = draft.sent ? draft.id : '';
  $('proof-tip').textContent = draft.sent
    ? 'Retry with the same UTR and screenshot. Pay only once.'
    : 'Submit your UTR and screenshot. MARC checks the bank record before confirming payment.';
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
  $('receipt-status').textContent = 'Payment status · ' + (entry.paymentStatus || 'Under review');
  $('order-number').textContent = entry.number || entry.id;
  $('back-to-orders').hidden = !ordersMode;
  $('order-time').dateTime = entry.submittedAt;
  $('order-time').textContent =
    indiaTime.format(new Date(entry.submittedAt)) + ' IST';
  $('receipt').querySelector('h2').focus({ preventScroll: true });
}
async function finishSubmission(saved, turn) {
  if (turn !== loadCount) return;
  if (saved.id !== draft?.id || !saved.token)
    throw Error('The order save could not be confirmed.');
  const completed = { ...draft, receipt: saved.token };
  delete completed.utr;
  const savedDraft = save(sessionStorage, DRAFT, completed);
  draft = completed;
  clearTimeout(statusTimer);
  proof.proof.value = '';
  if (turn === loadCount) {
    orderProgress.close();
    message();
    if (!ordersMode) openReceipt(saved);
  }
  try {
    await finishBag(completed);
  } catch {
    if (turn === loadCount)
      message('Your order was saved. Your browser could not update the bag.');
  }
  if (turn === loadCount && !savedDraft)
    message('Your order was saved. Keep a copy of your order reference.');
}
function pollOrder(turn) {
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => checkSubmission(turn), 12000 + Math.random() * 6000);
}
function queuedTitle(number) {
  return number ? 'Order submitted successfully' : 'Checking your order…';
}
function rememberQueuedOrder(number) {
  if (draft.queued && (!number || draft.queuedNumber === number)) return;
  draft = { ...draft, queued: true, ...(number ? { queuedNumber: number } : {}) };
  save(sessionStorage, DRAFT, draft);
}
function showPendingOrder(entry, turn) {
  rememberQueuedOrder(entry.number);
  const number = entry.number || draft.queuedNumber;
  const needsAttention = entry.status === 'needs_attention';
  const title = $('pending-title');
  const heading = needsAttention ? 'Order needs attention' : queuedTitle(number);
  const focus = $('pending-order').hidden || title.textContent !== heading;
  const detail = $('pending-message');
  const reference = $('pending-reference');

  orderProgress.close();
  proof.proof.value = '';
  title.textContent = heading;
  detail.textContent = needsAttention ? entry.message : '';
  detail.hidden = !needsAttention;
  $('pending-id-label').textContent = number ? 'Order ID' : 'Order reference';
  reference.textContent = number || (needsAttention ? entry.id : '');
  reference.parentElement.hidden = !reference.textContent;

  show('pending-order');
  summary(entry.lines, true);
  if (focus) title.focus({ preventScroll: true });
  message();
  if (!needsAttention) pollOrder(turn);
}
async function checkSubmission(turn) {
  if (turn !== loadCount || !draft?.quote) return 'handled';
  try {
    const entry = await post('status', { quote: draft.quote });
    if (turn !== loadCount) return 'handled';
    if (entry.id !== draft.id) throw Error('The order status could not be confirmed.');
    if (entry.token) await finishSubmission(entry, turn);
    else if (entry.status === 'processing' || entry.status === 'needs_attention')
      showPendingOrder(entry, turn);
    else if (entry.status === 'not_submitted') {
      if (!draft.queued) return 'not_submitted';
      // During the switchover, an older accepted proof may need to be uploaded again.
      const record = await post('resume', { quote: draft.quote });
      if (turn !== loadCount) return 'handled';
      draft = { ...draft, queued: false, sent: true };
      save(sessionStorage, DRAFT, draft);
      openPayment(record);
      showUploadRecovery();
    } else throw Error('The order status could not be confirmed.');
  } catch (e) {
    if (turn !== loadCount) return 'handled';
    if (e.status === 401) {
      expireSession('Sign in with the same Google account to check your order.');
      return 'handled';
    }
    if (!draft.queued && e.status !== 403 && e.status !== 409) return 'unavailable';
    message(e.message + ' Order reference ' + draft.id, true);
    if (draft.queued && e.status !== 403 && e.status !== 409) pollOrder(turn);
  }
  return 'handled';
}
async function myOrders(turn) {
  show('orders');
  summary([]);

  const out = $('past-orders');
  const history = read(localStorage, legacyReceiptKey, []);
  const entries = Array.isArray(history) ? history : [];
  const tokens = entries.slice(0, 12).map((entry) => entry?.token).filter(Boolean);
  if (draft?.receipt) tokens.push(draft.receipt);

  const active = draft?.quote && !draft.receipt ? draft : null;
  const submitted = active && (active.sent || active.queued);
  const list = node('div');
  const current = submitted ? node('div', 'past-order') : null;
  const uploadCheckUntil = Date.now() + 65000;
  let savedInHistory = false;
  let title;

  out.replaceChildren(list);
  if (current) {
    title = node('strong', '', queuedTitle());
    current.setAttribute('aria-live', 'polite');
    current.append(title);
    out.prepend(current);
  }

  function renderReceipt(row, entry, justSaved = false) {
    row.replaceChildren(
      node(
        'strong',
        '',
        money(entry.total) + ' · ' + indiaTime.format(new Date(entry.submittedAt))
      ),
      node('p', '', 'Order ID ' + (entry.number || entry.id)),
      node('p', 'line-meta', entry.paymentStatus || 'Payment under review'),
      btn('View receipt', 'text-btn', () => openReceipt(entry))
    );
    if (justSaved) row.prepend(node('p', 'line-meta', 'Order received successfully'));
  }

  function checkLater() {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(checkCurrent, 12000 + Math.random() * 6000);
  }

  async function checkCurrent() {
    if (turn !== loadCount || savedInHistory) return;

    try {
      const entry = await post('status', { quote: active.quote });
      if (turn !== loadCount) return;
      if (entry.id !== active.id) throw Error('Order status could not be confirmed.');

      if (entry.token) {
        if (!savedInHistory) renderReceipt(current, entry, true);
        await finishSubmission(entry, turn);
        return;
      }
      if (savedInHistory) return;

      if (entry.status === 'processing') {
        rememberQueuedOrder(entry.number);
        const number = entry.number || draft.queuedNumber;
        const heading = queuedTitle(number);
        if (title.textContent !== heading) {
          title.textContent = heading;
          current.replaceChildren(title);
          if (number) current.append(node('p', 'line-meta', 'Order ID ' + number));
        }
        checkLater();
      } else if (entry.status === 'needs_attention') {
        title.textContent = 'Order needs attention';
        current.replaceChildren(
          title,
          node('p', 'line-meta', entry.message),
          node('p', 'line-meta', 'Order reference ' + entry.id)
        );
      } else if (entry.status === 'not_submitted') {
        if (title.textContent !== 'Payment submission') {
          title.textContent = 'Payment submission';
          current.append(
            btn('Check payment submission', 'text-btn', () => location.assign('checkout.html'))
          );
        }
        if (Date.now() < uploadCheckUntil) checkLater();
      } else {
        checkLater();
      }
    } catch (error) {
      if (turn !== loadCount || savedInHistory) return;
      if (error.status === 401) {
        expireSession('Sign in with the same Google account to check your order.');
      } else if (error.status === 403 || error.status === 409) {
        title.textContent = error.status === 403
          ? 'Sign in with the account that started this checkout.'
          : 'Contact MARC to check this submission.';
        current.replaceChildren(title);
      } else {
        checkLater();
      }
    }
  }

  message('Loading your orders…');
  if (current) void checkCurrent();

  let receipts;
  try {
    receipts = await post('history', { tokens });
  } catch (error) {
    if (turn !== loadCount) return;
    if (!current || error.status === 401) throw error;
    list.append(node('p', 'card-meta', 'Try again to load your earlier orders.'));
    message('', true);
    return;
  }
  if (turn !== loadCount) return;

  savedInHistory = !!active && receipts.some((entry) => entry.id === active.id);
  if (savedInHistory) {
    current?.remove();
    clearTimeout(statusTimer);
  } else if (active && !current) {
    list.append(
      btn('Resume checkout', 'action navy', () => location.assign('checkout.html'))
    );
  }

  if (!receipts.length && !current) {
    list.append(node('p', 'card-meta', 'No orders found for this Google account.'));
  }

  for (const entry of receipts) {
    const row = node('div', 'past-order');
    renderReceipt(row, entry);
    list.append(row);
  }
  message();
}
async function boot() {
  const turn = ++loadCount;
  clearTimeout(statusTimer);
  clearTimeout(sessionCheckTimer);
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
      resetAccountBag();
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
    scheduleSessionCheck();
    void syncBag().catch(() => {});
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
      if (draft.sent && await checkSubmission(turn) === 'handled') return;
      if (turn !== loadCount) return;
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
window.addEventListener('pageshow', checkSession);
window.addEventListener('pagehide', resetGoogleSignIn);
document.addEventListener('visibilitychange', checkSession);
orderProgress.addEventListener('cancel', (event) => event.preventDefault());
googleProgress.addEventListener('cancel', (event) => event.preventDefault());
googleButton.onclick = startGoogleSignIn;

for (const id of ['switch-account', 'switch-order-account']) {
  $(id).onclick = async () => {
    try {
      await post('logout');
      resetAccountBag();
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

window.addEventListener('hashchange', () => {
  if (location.hash === '#payment-qr') $('payment-qr').open = true;
});

$('copy-upi').onclick = async () => {
  const status = $('upi-copy-status');
  try {
    await navigator.clipboard.writeText($('upi').textContent);
    status.textContent = 'Copied';
  } catch {
    status.textContent = 'Select the UPI ID to copy it.';
  }
};

function showUploadRecovery() {
  $('submit-proof-label').textContent = 'Retry upload';
  $('upload-recovery').hidden = false;
  $('recovery-reference').textContent = draft.id;
  message('We’re still checking your payment proof. Pay only once. Check again or retry the upload.', true);
}
async function sendProof(payload, pending, turn) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const progress = startOrderProgress();
    try {
      const saved = await api('place', {
        method: 'POST',
        body: payload,
        signal: AbortSignal.timeout(65000)
      });
      if (turn !== loadCount) return;
      if (saved.id !== pending.id) throw Error('The order save could not be confirmed.');
      if (saved.status === 'processing') showPendingOrder(saved, turn);
      else await finishSubmission(saved, turn);
      return;
    } catch (error) {
      if (turn !== loadCount) return;
      if (error.status === 401) {
        expireSession('Sign in with the same Google account to finish uploading your payment proof.');
        return;
      }
      if (error.status && error.status < 500 && error.status !== 429) {
        message(error.message + ' Checkout reference ' + pending.id);
        return;
      }

      orderProgress.close();
      const status = await checkSubmission(turn);
      if (turn !== loadCount || status === 'handled') return;
      if (status !== 'not_submitted' || attempt || error.status === 429) {
        showUploadRecovery();
        return;
      }
      message('Retrying your upload. Pay only once.');
    } finally {
      clearInterval(progress);
      orderProgress.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 1200 + Math.random() * 1200));
    if (turn !== loadCount) return;
  }
}

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
  const utr = proof.utr.value.trim();
  payload.set('utr', utr);
  payload.set('proof', image, image.name);
  if (paidWith) payload.set('paidWith', paidWith);

  const pending = { ...draft, sent: true, utr, ...(paidWith ? { paidWith } : {}) };
  if (!save(sessionStorage, DRAFT, pending)) {
    message(
      'Allow browser storage so you can recover this order if the connection drops.'
    );
    return;
  }

  draft = pending;
  proof.paidWith.disabled = true;
  $('payment-methods').hidden = true;
  $('proof-tip').textContent = 'Retry with the same UTR and screenshot. Pay only once.';
  $('cancel-unpaid').hidden = true;
  $('submit-proof').disabled = true;
  message();

  try {
    await sendProof(payload, pending, turn);
  } finally {
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
