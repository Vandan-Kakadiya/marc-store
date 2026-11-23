import { createHmac } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
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

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const frame = Buffer.alloc(body.length + 8);
  frame.writeUInt32BE(data.length, 0);
  body.copy(frame, 4);
  frame.writeUInt32BE(crc32(body), body.length + 4);
  return frame;
}

// Draws the same pixels as qrcode-generator's createDataURL(cellSize, margin)
// (dark modules black, everything else white) as a 1-bit greyscale PNG. The
// library's pure-JavaScript GIF encoder took ~15 ms of CPU per checkout; native
// zlib takes well under 1 ms and the image is smaller.
export function qrPng(qr, cellSize, margin) {
  const modules = qr.getModuleCount();
  const size = modules * cellSize + margin * 2;
  const stride = Math.ceil(size / 8) + 1;
  const raw = Buffer.alloc(stride * size, 0xff);
  for (let y = 0; y < size; y++) {
    const line = y * stride;
    raw[line] = 0; // PNG filter type: none
    if (y < margin || y >= size - margin) continue;
    const row = Math.floor((y - margin) / cellSize);
    for (let col = 0; col < modules; col++) {
      if (!qr.isDark(row, col)) continue;
      for (let x = margin + col * cellSize, end = x + cellSize; x < end; x++)
        raw[line + 1 + (x >> 3)] &= ~(0x80 >> (x & 7));
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 1; // bit depth
  header[9] = 0; // greyscale
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// Reopening the payment page asks for the same QR again; keep recent ones.
const recentQr = new Map();
export function upiQr(link) {
  let image = recentQr.get(link);
  if (image) recentQr.delete(link);
  else {
    const qr = qrcode(0, 'M');
    qr.addData(link);
    qr.make();
    image = 'data:image/png;base64,' + qrPng(qr, 5, 20).toString('base64');
    if (recentQr.size >= 200) recentQr.delete(recentQr.keys().next().value);
  }
  recentQr.set(link, image);
  return image;
}
