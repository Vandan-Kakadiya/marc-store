import {
  $,
  BAG,
  DRAFT,
  btn,
  cachedCatalogue,
  changeBag,
  configured,
  getBag,
  liveCatalogue,
  money,
  node,
  photo,
  picture,
  publishedCatalogue,
  read,
  save
} from './market-core.js?v=8';
const published = publishedCatalogue();
let catalog = published || cachedCatalogue(),
  bag = getBag(),
  busy = false,
  seenLive = Boolean(published),
  noticed = '',
  selected = '',
  selectedQuantity = 1,
  activeGroup = '',
  refreshTime = published ? Date.now() : 0;
let toastTimer, activePhoto, activeBanners;
const groups = () =>
  Object.values(
    catalog.skus.reduce((all, row) => {
      const key = JSON.stringify([
        row.name.toLowerCase(),
        row.colour.toLowerCase()
      ]);
      (all[key] ??= []).push(row);
      return all;
    }, Object.create(null))
  );
const groupKey = (rows) =>
  JSON.stringify([rows[0].name.toLowerCase(), rows[0].colour.toLowerCase()]);
const count = (items = bag) => items.reduce((n, r) => n + r.qty, 0);
const allowsOrder = () => configured && catalog.open;
const toast = (message) => {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  toastTimer = setTimeout(() => ($('toast').textContent = ''), 3000);
};
async function updateBag(reduce, reportError = toast) {
  try {
    bag = await changeBag(reduce);
    $('bag-count').textContent = count();
    return true;
  } catch (e) {
    reportError(e.message);
    return false;
  }
}
function repaint() {
  renderHomepageBanners();
  const all = groups(),
    names = [...new Set(catalog.skus.map((s) => s.name))],
    old = $('type').value;
  $('type').replaceChildren(
    new Option('All products', ''),
    ...names.map((v) => new Option(v, v))
  );
  if (names.includes(old)) $('type').value = old;
  $('filters').hidden = all.length < 2;
  $('type').hidden = names.length < 2;
  const query = $('filters').hidden
    ? ''
    : $('search').value.toLowerCase().trim();
  const filter = $('filters').hidden ? '' : $('type').value;
  const visible = all.filter(
    (rows) =>
      (!filter || rows[0].name === filter) &&
      (!query ||
        rows.some((s) =>
          [s.name, s.colour, s.size, s.sku]
            .join(' ')
            .toLowerCase()
            .includes(query)
        ))
  );
  const out = $('products');
  out.replaceChildren();
  $('result-count').textContent =
    visible.length + ' ' + (visible.length === 1 ? 'style' : 'styles');
  for (const rows of visible) {
    const row = rows[0],
      card = btn('', 'product-card', () => openProduct(rows)),
      prices = rows.map((s) => s.paise);
    card.append(
      picture(row, 'product-photo'),
      node('h3', '', row.name),
      node(
        'p',
        'card-meta',
        row.colour + ' · ' + rows.map((s) => s.size).join(', ')
      ),
      node(
        'p',
        'price',
        (Math.min(...prices) !== Math.max(...prices) ? 'From ' : '') +
          money(Math.min(...prices))
      )
    );
    out.append(card);
  }
  if (!visible.length)
    out.append(
      node(
        'p',
        'card-meta',
        all.length
          ? 'No matching merchandise.'
          : configured && !seenLive && !noticed
            ? 'Loading merchandise…'
            : 'New merchandise will appear here when MARC publishes it.'
      )
    );
  $('catalog-status').textContent =
    noticed ||
    (!configured
      ? 'Catalogue preview. Online ordering opens after store setup.'
      : seenLive && !catalog.open
        ? 'Ordering is paused. You can still browse the collection.'
        : '');
  $('bag-count').textContent = count();
  if ($('product').open) {
    const rows = all.find((g) => groupKey(g) === activeGroup);
    if (rows) renderProduct(rows);
    else {
      $('product').close();
      toast('This item is no longer listed.');
    }
  }
  if ($('bag').open) renderBag();
}
async function refresh() {
  if (busy || !configured) return;
  busy = true;
  refreshTime = Date.now();
  try {
    catalog = await liveCatalogue();
    seenLive = true;
    noticed = '';
    $('retry').hidden = true;
  } catch (e) {
    noticed = e.message + ' Showing the last available catalogue.';
    $('retry').hidden = false;
  } finally {
    busy = false;
    repaint();
  }
}
function openProduct(rows) {
  activeGroup = groupKey(rows);
  selected = rows.length === 1 ? rows[0].sku : '';
  selectedQuantity = 1;
  activePhoto = null;
  renderProduct(rows);
  $('product').showModal();
}
function createGallery(photos) {
  const gallery = node('div', 'product-gallery');
  gallery.setAttribute('role', 'group');
  gallery.setAttribute('aria-label', 'Product photos');
  const track = node('div', 'gallery-track');
  track.append(...photos.map((row) => picture(row, 'detail-photo')));
  gallery.append(track);
  setupCarousel(gallery, track, 'photo');
  return gallery;
}
function renderHomepageBanners() {
  const carousel = $('home-banners');
  if (!carousel) return;
  const banners = Array.isArray(catalog.homepageBanners)
    ? catalog.homepageBanners.filter((banner) =>
        banner &&
        typeof banner.image === 'string' &&
        photo(banner) &&
        typeof banner.title === 'string'
      ).slice(0, 6)
    : [];
  const key = JSON.stringify(banners);
  if (key === activeBanners) return;
  activeBanners = key;
  carousel.hidden = !banners.length;
  if (!banners.length) {
    carousel.replaceChildren();
    return;
  }

  const track = node('div', 'gallery-track campaign-track');
  banners.forEach((banner, index) => {
    const link = node('a', 'campaign-slide');
    link.href = typeof banner.href === 'string' && banner.href.startsWith('https://')
      ? banner.href
      : '#shop';
    const frame = picture({ image: banner.image, name: banner.title }, 'campaign-photo');
    const image = frame.querySelector('img');
    if (image) {
      image.alt = banner.title;
      if (index === 0) {
        image.loading = 'eager';
        image.fetchPriority = 'high';
      }
    }
    link.append(frame);
    track.append(link);
  });
  carousel.replaceChildren(track);
  setupCarousel(carousel, track, 'banner');
}
function setupCarousel(carousel, track, slideName) {
  const slideCount = track.children.length;
  if (slideCount < 2) return;
  track.tabIndex = 0;
  track.setAttribute('role', 'group');
  track.setAttribute('aria-label', 'Swipe or use arrow keys to view ' + slideName + 's');

  const controls = node('div', 'gallery-controls');
  const dots = Array.from(track.children, (_, index) => {
    const dot = btn('', 'gallery-dot', () => showPhoto(index));
    dot.setAttribute('aria-label', 'Show ' + slideName + ' ' + (index + 1) + ' of ' + slideCount);
    return dot;
  });
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let pointerDown = false,
    selectedDot = 0,
    timer;

  const current = () => Math.max(
    0,
    Math.min(slideCount - 1, Math.round(track.scrollLeft / (track.clientWidth || 1)))
  );
  function restartRotation() {
    clearTimeout(timer);
    if (reducedMotion || pointerDown) return;
    timer = setTimeout(() => {
      const dialog = track.closest('dialog');
      if (!track.isConnected || dialog?.open === false) return;
      if (
        document.hidden ||
        carousel.querySelector(':focus-visible') ||
        (!dialog && document.querySelector('dialog[open]'))
      ) {
        restartRotation();
        return;
      }
      const next = (current() + 1) % slideCount;
      showPhoto(next, next === 0);
  }, slideName === 'banner' ? 3000 : 4000);
  }
  function showPhoto(index, wrap = false) {
    track.scrollTo({
      left: index * track.clientWidth,
      behavior: wrap ? 'instant' : 'auto'
    });
    restartRotation();
  }
  dots[0].setAttribute('aria-current', 'true');
  controls.append(...dots);
  track.addEventListener(
    'scroll',
    () => {
      const index = current();
      if (index === selectedDot) return;
      dots[selectedDot].removeAttribute('aria-current');
      dots[index].setAttribute('aria-current', 'true');
      selectedDot = index;
      restartRotation();
    },
    { passive: true }
  );
  track.addEventListener('pointerdown', () => {
    pointerDown = true;
    restartRotation();
  });
  function releasePointer() {
    if (!pointerDown) return;
    pointerDown = false;
    restartRotation();
  }
  track.addEventListener('pointerup', releasePointer);
  track.addEventListener('pointercancel', releasePointer);
  track.addEventListener('pointerleave', releasePointer);
  function handleArrowKey(event) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const step = event.key === 'ArrowLeft' ? -1 : 1;
    showPhoto((current() + step + slideCount) % slideCount);
  }
  track.addEventListener('keydown', handleArrowKey);
  controls.addEventListener('keydown', handleArrowKey);
  carousel.append(controls);
  restartRotation();
}
function renderProductMedia(row, info) {
  const body = $('product-body');
  const extras = row.extraImages ?? [];
  const photos = JSON.stringify([row.image, extras, row.imageVariants]);
  // Keep the current slide when the shopper changes size.
  if (activePhoto === photos) {
    body.lastElementChild.replaceWith(info);
    return;
  }
  activePhoto = photos;
  const media = extras.length
    ? createGallery([row, ...extras.map((image) => ({ ...row, image, imageVariants: [] }))])
    : picture(row, 'detail-photo');
  body.replaceChildren(media, info);
}
function renderProduct(rows) {
  if (!rows.some((s) => s.sku === selected))
    selected = rows.length === 1 ? rows[0].sku : '';
  const picked = rows.find((s) => s.sku === selected),
    row = picked || rows[0],
    info = node('section', 'detail-info');
  const title = node('h2', '', row.name);
  title.id = 'product-title';
  info.append(
    title,
    node('p', 'modal-sub', row.colour),
    node(
      'p',
      'detail-price',
      money(picked ? picked.paise : Math.min(...rows.map((s) => s.paise)))
    )
  );
  const sizes = node('div', 'sizes');
  for (const option of rows) {
    const b = btn(option.size, '', () => {
      selected = option.sku;
      renderProduct(rows);
      $('product-body').querySelector('[aria-pressed=true]')?.focus();
    });
    b.setAttribute('aria-pressed', String(option.sku === selected));
    sizes.append(b);
  }
  const sizeOptions = node('div');
  sizeOptions.append(node('p', 'option-label', 'Size / option'), sizes);
  const quantityOptions = node('div', 'product-quantity');
  const quantityControl = node('div', 'control');
  quantityControl.setAttribute('role', 'group');
  quantityControl.setAttribute('aria-label', 'Quantity');
  const quantity = node('span');
  quantity.setAttribute('aria-live', 'polite');
  quantity.setAttribute('aria-atomic', 'true');
  const decrease = btn('−', '', () => changeQuantity(-1));
  decrease.setAttribute('aria-label', 'Decrease quantity');
  const increase = btn('+', '', () => changeQuantity(1));
  increase.setAttribute('aria-label', 'Increase quantity');
  selectedQuantity = Math.min(selectedQuantity, catalog.limit);
  quantityControl.append(decrease, quantity, increase);
  quantityOptions.append(node('p', 'option-label', 'Quantity'), quantityControl);
  const options = node('div', 'product-options');
  options.append(sizeOptions, quantityOptions);

  const orderNote = node('small');
  orderNote.setAttribute('aria-live', 'polite');
  const actions = node('div', 'buyline');
  const add = btn('Add to bag', 'action outline', async () => {
    const sku = selected;
    const qty = selectedQuantity;
    add.disabled = true;
    buy.disabled = true;
    decrease.disabled = true;
    increase.disabled = true;
    let errorMessage = '';
    const added = await updateBag(
      (items) => {
        if (count(items) + qty > catalog.limit)
          throw Error('This quantity would exceed the order limit.');
        const line = items.find((r) => r.sku === sku);
        if (line) line.qty += qty;
        else items.push({ sku, qty });
        return items;
      },
      (message) => {
        errorMessage = message;
      }
    );
    if (added) {
      if ($('product').open && activeGroup === groupKey(rows)) $('product').close();
      toast('Added to your bag.');
      return;
    }
    bag = getBag();
    $('bag-count').textContent = count();
    updatePurchaseOptions();
    orderNote.textContent = errorMessage;
  });
  const buy = btn('Buy now', 'action orange', () =>
    begin('buy-now', [{ sku: selected, qty: selectedQuantity }])
  );
  function updatePurchaseOptions() {
    const ordering = allowsOrder();
    const remaining = Math.max(0, catalog.limit - count());
    const fitsInBag = selectedQuantity <= remaining;
    quantity.textContent = selectedQuantity;
    decrease.disabled = !ordering || selectedQuantity <= 1;
    increase.disabled = !ordering || selectedQuantity >= catalog.limit;
    add.disabled = !picked || !ordering || !fitsInBag;
    buy.disabled = !picked || !ordering;

    if (!configured) orderNote.textContent = 'Preview only';
    else if (!ordering) orderNote.textContent = 'Ordering is paused.';
    else if (!fitsInBag) {
      orderNote.textContent = remaining
        ? 'You can add ' + remaining + ' more to your bag.'
        : 'Your bag has reached the order limit.';
    } else {
      const units = catalog.limit === 1 ? ' item' : ' items';
      orderNote.textContent = 'Maximum ' + catalog.limit + units + ' per order.';
    }
  }
  function changeQuantity(delta) {
    selectedQuantity += delta;
    updatePurchaseOptions();
  }
  updatePurchaseOptions();
  actions.append(add, buy);
  info.append(options, actions, orderNote);
  renderProductMedia(row, info);
}
function begin(flow, items) {
  const pending = read(sessionStorage, DRAFT, null);
  if (pending?.sent && !pending.receipt) {
    location.assign('checkout.html');
    return;
  }
  const draft = {
    flow,
    items: items.map((r) => ({ sku: r.sku, qty: r.qty })),
    id: crypto.randomUUID(),
    created: Date.now()
  };
  if (!save(sessionStorage, DRAFT, draft)) {
    toast('Allow browser storage to continue to checkout.');
    return;
  }
  location.assign('checkout.html');
}
function renderBag() {
  const out = $('bag-body');
  out.replaceChildren();
  bag = getBag();
  if (!bag.length) {
    out.append(
      node('p', 'card-meta', 'Your bag is empty.'),
      btn('Browse merchandise', 'text-btn', () => {
        $('bag').close();
        location.hash = 'shop';
      })
    );
    return;
  }
  let total = 0,
    missing = false;
  for (const item of bag) {
    const row = catalog.skus.find((s) => s.sku === item.sku);
    const line = node('div', 'bag-item'),
      text = node('div');
    text.append(
      node('strong', '', row?.name || item.sku),
      node(
        'p',
        'line-meta',
        row ? row.colour + ' / ' + row.size : 'Currently unavailable'
      )
    );
    if (row) total += row.paise * item.qty;
    else missing = true;
    const control = node('div', 'control');
    for (const delta of [-1, 1]) {
      const b = btn(delta === 1 ? '+' : '−', '', async () => {
        await updateBag((current) => {
          const entry = current.find((r) => r.sku === item.sku);
          if (entry && (delta < 0 || count(current) < catalog.limit))
            entry.qty += delta;
          return current.filter((r) => r.qty > 0);
        });
        renderBag();
      });
      b.setAttribute(
        'aria-label',
        (delta === 1 ? 'Increase ' : 'Decrease ') + item.sku + ' quantity'
      );
      b.disabled = delta > 0 && (!row || count() >= catalog.limit);
      if (delta === 1) control.append(node('span', '', item.qty));
      control.append(b);
    }
    text.append(control);
    line.append(
      picture(row || { name: '—', colour: '' }, 'thumb'),
      text,
      node('strong', '', row ? money(row.paise * item.qty) : '—')
    );
    out.append(line);
  }
  const totals = node('p', 'total');
  totals.append(node('span', '', 'Subtotal'), node('strong', '', money(total)));
  out.append(totals);
  const check = btn('Continue to checkout →', 'action navy', () =>
    begin('bag', bag)
  );
  check.disabled = missing || !allowsOrder() || count() > catalog.limit;
  out.append(check);
  if (missing || count() > catalog.limit)
    out.append(
      node('p', 'status', 'Adjust the items in your bag before checkout.')
    );
}
$('open-bag').onclick = () => {
  renderBag();
  $('bag').showModal();
};
$('retry').onclick = refresh;
for (const d of document.querySelectorAll('dialog'))
  d.addEventListener('click', (e) => {
    if (e.target === d) {
      const r = d.getBoundingClientRect();
      if (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      )
        d.close();
    }
  });
for (const b of document.querySelectorAll('[data-close]'))
  b.onclick = () => $(b.dataset.close).close();
$('search').oninput = repaint;
$('type').onchange = repaint;
window.addEventListener('storage', (e) => {
  if (e.key === BAG) {
    bag = getBag();
    repaint();
  }
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() - refreshTime > 15000) refresh();
});
window.addEventListener('pageshow', (e) => {
  if (e.persisted) refresh();
});
setInterval(() => {
  if (!document.hidden) refresh();
}, 60000);
const startupLoader = $('store-loading');
function hideStartupLoader() {
  if (!startupLoader) return;
  startupLoader.hidden = true;
  startupLoader.setAttribute('data-ready', '');
}
repaint();
if (published || catalog.skus.length || !configured) hideStartupLoader();
if (!published) refresh().finally(hideStartupLoader);
