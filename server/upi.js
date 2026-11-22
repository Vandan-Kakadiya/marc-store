import { createHmac } from 'node:crypto';
import qrcode from 'qrcode-generator';

export function upiOrder(payment, { id, buyer, total }, sessionKey) {
  const upi = payment.upi.trim();
  if (
    !/^[a-z0-9][a-z0-9._-]*@[a-z][a-z0-9]+$/i.test(upi) ||
    /[\x00-\x1f\x7f]/.test(payment.payee)
  )
    return {};

  const upiReference = 'MARC' + createHmac('sha256', Buffer.from(sessionKey, 'hex'))
    .update('marc-vercel:upi-order\0')
    .update(JSON.stringify([id, buyer, total, upi]))
    .digest('hex')
    .slice(0, 28)
    .toUpperCase();
  const params = new URLSearchParams({
    pa: upi,
    pn: payment.payee,
    tr: upiReference,
    tn: 'Order ' + upiReference,
    am: (total / 100).toFixed(2),
    cu: 'INR'
  });
  if (payment.merchantCode) params.set('mc', payment.merchantCode);
  return {
    upi,
    upiReference,
    upiLink: 'upi://pay?' + params.toString().replaceAll('+', '%20')
  };
}

export function upiQr(link) {
  const qr = qrcode(0, 'M');
  qr.addData(link);
  qr.make();
  return qr.createDataURL(5, 20);
}
