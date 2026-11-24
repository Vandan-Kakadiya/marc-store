import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { checkoutQr, configureUpiPicker } from '../dist/upi-apps.js';
import { upiOrder, upiQr } from '../server/upi.js';

const android = { userAgent: 'Android Chrome/140' };
const iphone = { userAgent: 'iPhone Safari' };
const origin = 'https://marc.example.test';
const total = 79900;
const payment = { payee: 'Campus & Co', upi: 'campus@examplebank', merchantCode: '5999' };
Object.assign(payment, upiOrder(payment, { id: 'fixture', buyer: 'fixture', total }, 'a'.repeat(64)));

function menu() {
  const choices = new Map();
  return { open: false, querySelector(id) {
    if (!choices.has(id)) choices.set(id, { removeAttribute(key) { delete this[key]; } });
    return choices.get(id);
  } };
}

test('a quoted UPI ID uses only its own QR while QR-only collections use their configured image', () => {
  const staticQr = 'https://marc.example.test/qr.png';
  const generated = upiQr(payment.upiLink);
  const config = { ...payment, qr: staticQr, orderQr: generated };
  assert.equal(checkoutQr(config, true).source, generated);
  assert.equal(checkoutQr({ ...config, orderQr: '' }, true).source, '');
  assert.equal(checkoutQr(config, false).source, '');
  assert.equal(checkoutQr({ upi: '', qr: staticQr }, false).source, staticQr);
});

test('the primary mobile payment control expands in the page and has no external destination', async () => {
  const html = await readFile(new URL('../dist/checkout.html', import.meta.url), 'utf8');
  assert.match(html, /<details id="upi-app-payment" hidden>\s*<summary[^>]*id="pay-with-upi">Choose a UPI app<\/summary>/);
  assert.doesNotMatch(html.match(/<summary[^>]*id="pay-with-upi"[^>]*>/)[0], /href=|onclick=/);
  assert.match(html, /id="upi-scan" href="#payment-qr"/);
});

test('returning after Paytm lets the next order target any named Android app', () => {
  const picker = menu();
  const nextTotal = 49950;
  const next = { ...payment, ...upiOrder(payment, { id: 'next', buyer: 'fixture', total: nextTotal }, 'a'.repeat(64)) };
  configureUpiPicker(picker, payment, total, android, origin);
  const old = picker.querySelector('#upi-paytm').href;
  picker.open = true;
  configureUpiPicker(picker, next, nextTotal, android, origin);
  assert.equal(picker.open, false);
  assert.equal(picker.hidden, false);
  assert.notEqual(picker.querySelector('#upi-paytm').href, old);
  const query = next.upiLink.slice('upi://pay'.length);
  for (const [id, pkg] of [['upi-gpay', 'com.google.android.apps.nbu.paisa.user'],
    ['upi-phonepe', 'com.phonepe.app'], ['upi-paytm', 'net.one97.paytm']]) {
    assert.equal(picker.querySelector('#' + id).href, 'intent://pay' + query +
      '#Intent;scheme=upi;package=' + pkg + ';S.browser_fallback_url=' +
      encodeURIComponent(origin + '/checkout.html#payment-qr') + ';end');
  }
  assert.equal(picker.querySelector('#upi-default').href, next.upiLink);
});

test('iPhone and iPad use explicit app links and preserve the exact payment query', () => {
  for (const device of [iphone, { userAgent: 'Safari', platform: 'MacIntel', maxTouchPoints: 5 }]) {
    const picker = menu();
    configureUpiPicker(picker, payment, total, device, origin);
    const query = payment.upiLink.slice('upi://pay'.length);
    for (const [id, base] of [['upi-gpay', 'gpay://upi/pay'], ['upi-phonepe', 'phonepe://pay'],
      ['upi-paytm', 'paytmmp://upi/pay']]) {
      assert.equal(picker.querySelector('#' + id).href, base + query);
    }
    assert.equal(picker.querySelector('#upi-default').hidden, true);
    assert.equal(picker.querySelector('#upi-default').href, undefined);
  }
});

test('desktop, QR-only checkout and inconsistent payment details clear previous app links', () => {
  const picker = menu();
  for (const [data, device] of [[payment, { userAgent: 'Desktop' }], [{ ...payment, upiLink: '' }, iphone],
    [{ ...payment, upi: 'previous@examplebank' }, android],
    [{ ...payment, upiLink: payment.upiLink.replace('am=799.00', 'am=50.00') }, android],
    [{ ...payment, upiLink: payment.upiLink + '&am=799.00' }, android]]) {
    configureUpiPicker(picker, payment, total, android, origin);
    configureUpiPicker(picker, data, total, device, origin);
    assert.equal(picker.hidden, true);
    for (const id of ['upi-gpay', 'upi-phonepe', 'upi-paytm', 'upi-default'])
      assert.equal(picker.querySelector('#' + id).href, undefined);
  }
});
