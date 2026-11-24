const apps = [
  ['upi-gpay', 'com.google.android.apps.nbu.paisa.user', 'gpay://upi/pay'],
  ['upi-phonepe', 'com.phonepe.app', 'phonepe://pay'],
  ['upi-paytm', 'net.one97.paytm', 'paytmmp://upi/pay']
];

export function checkoutQr(payment, validLink) {
  const hasUpiId = /^[a-z0-9][a-z0-9._-]*@[a-z][a-z0-9]+$/i.test(payment.upi);
  const orderQr = validLink && /^data:image\/(png|gif);base64,/.test(payment.orderQr || '') ? payment.orderQr : '';
  // A separately configured QR may still belong to a previous collection's payee.
  const source = orderQr || (!hasUpiId && !payment.upiLink ? payment.qr : '');
  return { hasUpiId, orderQr, source };
}

// The payment destination and amount come from the same server quote as the QR.
// Only the app that receives the handoff changes.
export function configureUpiPicker(picker, payment, total, device, origin) {
  const android = device.userAgentData?.platform === 'Android' || /Android/i.test(device.userAgent);
  const ios = /iPhone|iPad|iPod/i.test(device.userAgent) ||
    (device.platform === 'MacIntel' && device.maxTouchPoints > 1);
  const raw = payment.upiLink;
  let query = '';
  if (typeof raw === 'string' && raw.startsWith('upi://pay?') && !/[#\s]/.test(raw)) {
    const params = new URLSearchParams(raw.slice('upi://pay?'.length));
    const required = { pa: payment.upi, am: (total / 100).toFixed(2), cu: 'INR' };
    if (Number.isSafeInteger(total) && total > 0 && Object.entries(required).every(
      ([key, value]) => value && params.getAll(key).length === 1 && params.get(key) === value
    )) query = raw.slice('upi://pay'.length);
  }
  const show = Boolean(query && (android || ios));
  picker.hidden = !show;
  picker.open = false;
  const fallback = encodeURIComponent(new URL('/checkout.html#payment-qr', origin).href);
  for (const [id, pkg, scheme] of apps) {
    const option = picker.querySelector('#' + id);
    if (!show) option.removeAttribute('href');
    else if (android) {
      option.href = 'intent://pay' + query + '#Intent;scheme=upi;package=' + pkg +
        ';S.browser_fallback_url=' + fallback + ';end';
    } else option.href = scheme + query;
  }
  const phoneDefault = picker.querySelector('#upi-default');
  phoneDefault.hidden = !(show && android);
  if (phoneDefault.hidden) phoneDefault.removeAttribute('href');
  else phoneDefault.href = raw;
  return { mobile: android || ios, validLink: Boolean(query) };
}
