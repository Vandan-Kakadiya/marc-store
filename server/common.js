import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export class CheckoutError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export function fail(status, message) {
  throw new CheckoutError(status, message);
}
export const sha256Pattern = /^[a-f0-9]{64}$/;
export const orderPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const skuPattern = /^[A-Za-z0-9_-]{1,64}$/;
export const proofLimit = 4 * 1024 * 1024;
export const secret = () => randomBytes(32).toString('base64url');

export function siteURL(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
    )
      return url.origin;
  } catch {}
  return '';
}
export function json(value, status = 200, headers = {}) {
  return Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      ...headers
    }
  });
}
export async function readBytes(req, limit) {
  if (!req.body || Number(req.headers.get('content-length')) > limit)
    fail(
      req.body ? 413 : 400,
      req.body
        ? 'The file is too large. Choose a screenshot up to 4 MB.'
        : 'The request was empty.'
    );
  const reader = req.body.getReader(),
    parts = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      fail(413, 'The request is too large.');
    }
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts, size);
}
export async function readJSON(req, limit = 22000) {
  if (req.headers.get('content-type')?.split(';')[0] !== 'application/json')
    fail(415, 'Send checkout details as JSON.');
  const raw = await readBytes(req, limit);
  let value;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch {
    fail(400, 'Invalid checkout data.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(400, 'Invalid checkout data.');
  return value;
}
export function seal(value, purpose, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  cipher.setAAD(Buffer.from('marc-vercel:' + purpose));
  return Buffer.concat([
    iv,
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
    cipher.getAuthTag()
  ]).toString('base64url');
}
export function unseal(value, purpose, key, maxLength = 63000) {
  if (!value || value.length > maxLength || !/^[a-zA-Z0-9_-]+$/.test(value))
    return null;
  try {
    const raw = Buffer.from(value, 'base64url'),
      end = raw.length - 16;
    const decoder = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(key, 'hex'),
      raw.subarray(0, 12)
    );
    decoder.setAAD(Buffer.from('marc-vercel:' + purpose));
    decoder.setAuthTag(raw.subarray(end));
    const data = JSON.parse(
      Buffer.concat([decoder.update(raw.subarray(12, end)), decoder.final()])
    );
    return Number.isFinite(data.expires) && data.expires > Date.now()
      ? data
      : null;
  } catch {
    return null;
  }
}
export function requiredText(value, max, field) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim().length > max ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    fail(400, 'Check ' + field + '.');
  return value.trim();
}
