import { skuPattern, sha256Pattern } from './common.js';

export const emptyCatalogue = {
  apiVersion: 3,
  ready: false,
  products: [],
  maxItems: 5,
  terms: '',
  version: ''
};
function imageOK(value) {
  if (value === '') return true;
  if (typeof value !== 'string' || value.length > 1500) return false;
  if (value.startsWith('assets/')) {
    try {
      const decoded = decodeURIComponent(value);
      return (
        /^assets\/[a-zA-Z0-9_ ./()-]+$/.test(decoded) &&
        !decoded.split('/').some((p) => !p || p === '.' || p === '..')
      );
    } catch {
      return false;
    }
  }
  return publicImage(value);
}
export function publicImage(value) {
  try {
    const u = new URL(value);
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      value.length <= 1500
    );
  } catch {
    return false;
  }
}
export function validateCatalogue(obj) {
  if (
    !obj ||
    obj.apiVersion !== 3 ||
    typeof obj.ready !== 'boolean' ||
    !Array.isArray(obj.products) ||
    obj.products.length > 500 ||
    typeof obj.terms !== 'string' ||
    obj.terms.length > 12000 ||
    !Number.isInteger(obj.maxItems) ||
    obj.maxItems < 1 ||
    obj.maxItems > 100 ||
    (obj.version !== '' && !sha256Pattern.test(obj.version))
  )
    throw Error('Invalid catalogue snapshot.');
  const groups = new Set(),
    codes = new Set();
  const products = obj.products.map((p) => {
    const extraImages = p?.extraImages ?? [];
    if (
      !p ||
      !/^[a-f0-9]{24}$/.test(p.id || '') ||
      groups.has(p.id) ||
      typeof p.name !== 'string' ||
      !p.name.trim() ||
      p.name.length > 140 ||
      typeof p.colour !== 'string' ||
      !p.colour.trim() ||
      p.colour.length > 100 ||
      !imageOK(p.image) ||
      !Array.isArray(extraImages) ||
      extraImages.length > 2 ||
      (extraImages.length > 0 && !p.image) ||
      extraImages.some((src) => !src || src === p.image || !imageOK(src)) ||
      new Set(extraImages).size !== extraImages.length ||
      !Array.isArray(p.skus) ||
      !p.skus.length
    )
      throw Error('Invalid product in catalogue.');
    groups.add(p.id);
    const sizes = new Set();
    const skus = p.skus.map((s) => {
      if (
        !s ||
        typeof s.sku !== 'string' ||
        !skuPattern.test(s.sku) ||
        codes.has(s.sku) ||
        typeof s.size !== 'string' ||
        !s.size.trim() ||
        s.size.length > 60 ||
        sizes.has(s.size.toLowerCase()) ||
        !Number.isSafeInteger(s.paise) ||
        s.paise < 1 ||
        s.paise > 100000000
      )
        throw Error('Invalid option in catalogue.');
      codes.add(s.sku);
      sizes.add(s.size.toLowerCase());
      return { sku: s.sku, size: s.size, paise: s.paise, price: s.paise / 100 };
    });
    return {
      id: p.id,
      name: p.name,
      colour: p.colour,
      image: p.image,
      skus,
      ...(extraImages.length ? { extraImages } : {})
    };
  });
  if (codes.size > 1000) throw Error('The catalogue has too many options.');
  const p = obj.payment;
  const payment =
    p &&
    publicImage(p.qr) &&
    typeof p.payee === 'string' &&
    !!p.payee.trim() &&
    p.payee.length <= 120 &&
    typeof p.upi === 'string' &&
    p.upi.length <= 160
      ? { qr: p.qr, payee: p.payee, upi: p.upi }
      : null;
  if (obj.ready && (!products.length || !payment || !obj.version))
    throw Error('Open catalogue is missing details.');
  return {
    ...emptyCatalogue,
    ready: obj.ready,
    products,
    maxItems: obj.maxItems,
    version: obj.version,
    terms: obj.terms,
    payment
  };
}
