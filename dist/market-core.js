export const configured =
  !window.MARC_PREVIEW && /^https?:$/.test(location.protocol);
export const affiliations = [
  'PGPM 2026-28',
  'PGPM 2025-27',
  'PGPM HR 2026-28',
  'PGPM HR 2025-27',
  'Staff',
  'Other'
];
export const BAG = 'marc-market-bag-v3',
  DRAFT = 'marc-vercel-checkout-v1',
  CACHE = 'marc-vercel-catalogue-v1';
export const $ = (id) => document.getElementById(id);
const rupeeFormats = [0, 2].map((digits) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: digits,
    maximumFractionDigits: 2
  })
);
export const money = (paise) =>
  rupeeFormats[paise % 100 ? 1 : 0].format(paise / 100);
export function read(store, key, fallback) {
  try {
    return JSON.parse(store.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
export function save(store, key, value) {
  try {
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
function bagState() {
  const current = read(localStorage, BAG, null);
  const items = current?.items || read(localStorage, 'marc-polo-bag-v2', []);
  return {
    items: Array.isArray(items)
      ? items.filter(
          (r) =>
            r &&
            /^[A-Za-z0-9_-]{1,64}$/.test(r.sku) &&
            Number.isInteger(r.qty) &&
            r.qty > 0
        )
      : [],
    settled: Array.isArray(current?.settled) ? current.settled : []
  };
}
export function getBag() {
  return bagState().items;
}
export async function changeBag(reduce, orderId = null) {
  const change = () => {
    const state = bagState();
    if (orderId && state.settled.includes(orderId)) return state.items;
    state.items = reduce(state.items);
    if (orderId) state.settled.push(orderId);
    if (!save(localStorage, BAG, state))
      throw Error('Your browser could not save the bag.');
    return state.items;
  };
  return globalThis.navigator?.locks
    ? navigator.locks.request(BAG, change)
    : change();
}
export function node(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}
export function btn(text, cls, fn) {
  const el = node('button', cls, text);
  el.type = 'button';
  el.addEventListener('click', fn);
  return el;
}
export function photo(row, small = true) {
  let src = row.image || '';
  if (!src) return '';
  const path = src.replace(/^\.\//, '');
  const match = path.match(
    /^assets\/polo-(white|maroon)(?:-480)?\.(?:png|webp)(?:\?.*)?$/
  );
  if (match) return 'assets/polo-' + match[1] + (small ? '-480' : '') + '.webp';
  if (path.startsWith('assets/')) {
    try {
      const local = decodeURIComponent(path);
      if (
        /^assets\/[A-Za-z0-9_ ./()-]+$/.test(local) &&
        !local.split('/').some((s) => !s || s === '.' || s === '..')
      )
        return local.split('/').map(encodeURIComponent).join('/');
    } catch {}
    return '';
  }
  try {
    const u = new URL(src);
    return u.protocol === 'https:' ? u.href : '';
  } catch {
    return '';
  }
}
export function picture(row, cls) {
  const frame = node('div', cls),
    src = photo(row);
  function placeholder() {
    frame.replaceChildren(node('span', 'no-photo', row.name));
  }
  if (!src) {
    placeholder();
    return frame;
  }
  const im = node('img');
  im.alt = row.name + ' · ' + row.colour;
  im.loading = 'lazy';
  im.decoding = 'async';
  const variants = row.imageVariants;
  if (variants?.length) {
    im.sizes =
      cls === 'detail-photo'
        ? '(max-width: 680px) 88vw, 480px'
        : cls === 'thumb'
          ? '64px'
          : '(max-width: 680px) 36vw, (max-width: 950px) 24vw, 260px';
    im.srcset = variants
      .map(({ src, width }) => src + ' ' + width + 'w')
      .join(', ');
  }
  im.addEventListener('error', () => {
    if (im.srcset) {
      im.removeAttribute('srcset');
      im.src = src;
    } else placeholder();
  });
  im.src = variants?.[0]?.src || src;
  frame.append(im);
  return frame;
}
const designPreview = {
  open: false,
  version: '',
  limit: 5,
  terms: '',
  skus: [
    {
      sku: 'POLO-WHITE-M',
      name: 'MARC Polo',
      colour: 'White',
      size: 'M',
      image: 'assets/polo-white.png',
      paise: 79900
    }
  ]
};
export const initial = configured
  ? { ...designPreview, skus: [] }
  : designPreview;
export function cachedCatalogue() {
  const entry = read(localStorage, CACHE, null);
  return entry &&
    Date.now() - entry.time < 86400000 &&
    Array.isArray(entry.catalog?.skus)
    ? entry.catalog
    : initial;
}
export async function api(action, options = {}) {
  if (!configured) throw Error('Open the deployed store to continue.');
  let response;
  try {
    response = await fetch(
      '/api/checkout?action=' + encodeURIComponent(action),
      {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: AbortSignal.timeout(12000),
        ...options
      }
    );
  } catch {
    throw Error(
      action === 'place'
        ? 'The save is unconfirmed. Retry Place order with the same UTR and screenshot. Pay only once.'
        : 'Could not connect to the store. Check your connection and try again.'
    );
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || data === null) {
    const error = Error(
      data?.error ||
        (action === 'place'
          ? 'The save is unconfirmed. Retry with the same UTR and screenshot. Pay only once.'
          : 'The store could not complete this request.')
    );
    error.status = response.status;
    throw error;
  }
  return data;
}
export const post = (action, data = {}) =>
  api(action, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data)
  });
function saveCatalogue(data) {
  if (data?.apiVersion !== 3 || !Array.isArray(data.products))
    throw Error('The published catalogue is unavailable.');
  const skus = data.products.flatMap((p) => {
    const imageVariants = Array.isArray(p.imageVariants)
      ? p.imageVariants.filter((variant) =>
          [480, 960].includes(variant?.width) &&
          typeof variant.src === 'string' &&
          /^assets\/optimized\/[a-f0-9]{20}-(480|960)\.webp$/.test(variant.src)
        )
      : [];
    const extraImages = Array.isArray(p.extraImages)
      ? [...new Set(p.extraImages.filter(
          (src) => typeof src === 'string' && src !== p.image && photo({ image: src })
        ))].slice(0, 2)
      : [];
    return p.skus.map((s) => ({
      sku: s.sku,
      name: p.name,
      colour: p.colour,
      size: s.size,
      paise: s.paise,
      image: p.image,
      imageVariants,
      extraImages
    }));
  });
  const catalog = {
    skus,
    homepageBanners: Array.isArray(data.homepageBanners) ? data.homepageBanners : [],
    open: data.ready === true,
    version: data.version,
    limit: data.maxItems,
    terms: data.terms
  };
  save(localStorage, CACHE, { time: Date.now(), catalog });
  return catalog;
}
export function publishedCatalogue() {
  if (!configured) return null;
  try {
    return saveCatalogue(JSON.parse($('catalogue-snapshot')?.textContent || ''));
  } catch {
    return null;
  }
}
export async function liveCatalogue() {
  const response = await fetch('/catalogue.json', {
    cache: 'no-cache',
    signal: AbortSignal.timeout(9000)
  });
  if (!response.ok) throw Error('Could not load the published catalogue.');
  return saveCatalogue(await response.json());
}
export async function finishBag(draft) {
  if (draft.flow !== 'bag' || draft.bagSettled) return;
  const bought = new Map(draft.items.map((r) => [r.sku, r.qty]));
  await changeBag(
    (items) =>
      items
        .map((r) => ({ ...r, qty: r.qty - (bought.get(r.sku) || 0) }))
        .filter((r) => r.qty > 0),
    draft.id
  );
}
