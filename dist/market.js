import {
  $,
  BAG,
  bagSignedIn,
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
  removeBagSkus,
  save,
  syncBag
} from './market-core.js?v=14';
import { setupHeroVideo } from './hero-video.js';
const published = publishedCatalogue();
const renderHeroVideo = setupHeroVideo();
const indexSkus = (catalogue) => new Map(catalogue.skus.map((row) => [row.sku, row]));
let catalog = published || cachedCatalogue(),
  skusById = indexSkus(catalog),
  busy = false,
  seenLive = Boolean(published),
  noticed = '',
  selected = '',
  selectedQuantity = 1,
  activeGroup = '',
  refreshTime = published ? Date.now() : 0;
let toastTimer, activeProductMedia, activeBanners;
let activeProductTab = 0;
const girlsSection = $('girls-edition');
const girlsProducts = $('girls-products');
const isGirlsEdition = (row) => /^GIRLS-/i.test(row.sku);
const groupKey = ([row]) =>
  JSON.stringify([row.name.toLowerCase(), row.colour.toLowerCase(), isGirlsEdition(row)]);
const groups = () =>
  Object.values(
    catalog.skus.reduce((all, row) => {
      const key = groupKey([row]);
      (all[key] ??= []).push(row);
      return all;
    }, Object.create(null))
  );
const listedBagItems = (items = getBag()) => items.filter(({ sku }) => skusById.has(sku));
const count = (items) => listedBagItems(items).reduce((n, r) => n + r.qty, 0);
const allowsOrder = () => configured && catalog.open;
const setText = (el, text) => {
  if (el.textContent !== text) el.textContent = text;
};
const catalogueKey = (c) =>
  JSON.stringify([c.skus, c.homepageBanners, c.homepageVideos, c.open, c.version, c.limit, c.terms]);
let catalogKey = catalogueKey(catalog),
  cardsFor = null,
  cards = [],
  typeNames = '',
  emptyNote;
const toast = (message) => {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  toastTimer = setTimeout(() => ($('toast').textContent = ''), 3000);
};
async function updateBag(reduce, reportError = toast) {
  try {
    await changeBag(reduce);
    setText($('bag-count'), String(count()));
    return true;
  } catch (e) {
    reportError(e.message);
    return false;
  }
}
function customizationLabel(rows) {
  const fields = new Set(rows.flatMap((row) => row.printFields ?? []));
  if (!fields.size) return '';

  if (fields.size === 2) {
    const bothOnOneSku = rows.some(({ printFields }) =>
      printFields?.includes('name') && printFields.includes('number')
    );
    return bothOnOneSku ? 'Customised name & number' : 'Customised name or number';
  }

  return fields.has('name') ? 'Customised name' : 'Customised number';
}
function buildCards() {
  cardsFor = catalog;
  cards = groups().map((rows) => {
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
      )
    );
    const label = customizationLabel(rows);
    if (label) card.append(node('span', 'card-customization', label));
    card.append(
      node(
        'p',
        'price',
        (Math.min(...prices) !== Math.max(...prices) ? 'From ' : '') +
          money(Math.min(...prices))
      )
    );
    // One line per option, so a search never matches across two options.
    const text = rows
      .map((s) => [s.name, s.colour, s.size, s.sku].join(' '))
      .join('\n')
      .toLowerCase();
    return { rows, card, text };
  });
  emptyNote = node('p', 'card-meta');
  const generalCards = [];
  const girlsCards = [];
  for (const { rows, card } of cards) {
    const target = girlsProducts && isGirlsEdition(rows[0]) ? girlsCards : generalCards;
    target.push(card);
  }
  $('products').replaceChildren(...generalCards, emptyNote);
  girlsProducts?.replaceChildren(...girlsCards);
}
function repaint(dialogs = false) {
  renderHomepageBanners();
  renderHeroVideo(catalog.homepageVideos);
  // Cards are rebuilt only when the catalogue changes. Searching, filtering
  // and the background refresh just show or hide the existing cards.
  const changed = cardsFor !== catalog;
  if (changed) buildCards();
  const names = [...new Set(catalog.skus.map((s) => s.name))],
    type = $('type'),
    namesKey = JSON.stringify(names);
  if (namesKey !== typeNames) {
    typeNames = namesKey;
    const old = type.value;
    type.replaceChildren(
      new Option('All products', ''),
      ...names.map((v) => new Option(v, v))
    );
    if (names.includes(old)) type.value = old;
  }
  $('filters').hidden = cards.length < 2;
  type.hidden = names.length < 2;
  const query = $('filters').hidden
    ? ''
    : $('search').value.toLowerCase().trim();
  const filter = $('filters').hidden ? '' : type.value;
  let shown = 0;
  let shownGirls = 0;
  for (const { rows, card, text } of cards) {
    const visible =
      (!filter || rows[0].name === filter) && (!query || text.includes(query));
    if (card.hidden === visible) card.hidden = !visible;
    if (visible) {
      shown++;
      if (girlsProducts && isGirlsEdition(rows[0])) shownGirls++;
    }
  }
  if (girlsSection) girlsSection.hidden = shownGirls === 0;
  $('products').hidden = shownGirls > 0 && shown === shownGirls;
  setText($('result-count'), shown + ' ' + (shown === 1 ? 'style' : 'styles'));
  emptyNote.hidden = shown > 0;
  if (!shown)
    setText(
      emptyNote,
      cards.length
        ? 'No matching merchandise.'
        : configured && !seenLive && !noticed
          ? 'Loading merchandise…'
          : 'New merchandise will appear here when MARC publishes it.'
    );
  setText(
    $('catalog-status'),
    noticed ||
      (!configured
        ? 'Catalogue preview. Online ordering opens after store setup.'
        : seenLive && !catalog.open
          ? 'Ordering is paused. You can still browse the collection.'
          : '')
  );
  setText($('bag-count'), String(count()));
  if (!changed && !dialogs) return;
  if ($('product').open) {
    const rows = cards.find((c) => groupKey(c.rows) === activeGroup)?.rows;
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
    const next = await liveCatalogue();
    const key = catalogueKey(next);
    // Keep the same object when nothing changed so repaint() skips the rebuild.
    if (key !== catalogKey) {
      catalog = next;
      catalogKey = key;
      skusById = indexSkus(catalog);
    }
    if (next.canPruneBag) {
      const removed = new Set(getBag().filter(({ sku }) => !skusById.has(sku)).map(({ sku }) => sku));
      // The bag already hides these items. Retry saving the cleanup on the next refresh if needed.
      if (removed.size) void removeBagSkus(removed).catch(() => {});
    }
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
  activeProductMedia = null;
  activeProductTab = 0;
  renderProduct(rows);
  $('product').showModal();
  $('product-body').scrollTop = 0;
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
  const later = [];
  banners.forEach((banner, index) => {
    const link = node('a', 'campaign-slide');
    link.href = typeof banner.href === 'string' && banner.href.startsWith('https://')
      ? banner.href
      : '#shop';
    // Only the first banner downloads with the page. The others wait for the
    // load event so they don't compete with it on slow connections.
    const frame = picture({ ...banner, name: banner.title }, 'campaign-photo', index > 0);
    const image = frame.querySelector('img');
    if (image) {
      image.alt = banner.title;
      image.loading = 'eager';
      image.fetchPriority = index === 0 ? 'high' : 'low';
      if (frame.loadImage) later.push(frame.loadImage);
    }
    link.append(frame);
    track.append(link);
  });
  const loadLater = () => later.splice(0).forEach((load) => load());
  carousel.replaceChildren(track);
  setupCarousel(carousel, track, 'banner', loadLater);
  if (document.readyState === 'complete') setTimeout(loadLater);
  else window.addEventListener('load', () => setTimeout(loadLater), { once: true });
}
function setupCarousel(carousel, track, slideName, prepare = () => {}) {
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
    waited = false,
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
        track.closest('[hidden]') ||
        carousel.querySelector(':focus-visible') ||
        (!dialog && document.querySelector('dialog[open]'))
      ) {
        restartRotation();
        return;
      }
      const next = (current() + 1) % slideCount;
      prepare();
      // Give a photo that is still downloading one more interval rather than
      // rotating to an empty frame.
      const image = track.children[next]?.querySelector('img');
      if (image && !image.complete && !waited) {
        waited = true;
        restartRotation();
        return;
      }
      waited = false;
      showPhoto(next, next === 0);
  }, slideName === 'banner' ? 3000 : 4000);
  }
  function showPhoto(index, wrap = false) {
    prepare();
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
      prepare();
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
    prepare();
    pointerDown = true;
    restartRotation();
  });
  carousel.addEventListener('focusin', prepare);
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
function appendProductInfoImage(panel, image, alt, fallback) {
  const src = photo({ image }, false);
  if (!src) {
    if (fallback) panel.append(fallback);
    return;
  }
  const img = node('img', 'detail-content-image');
  img.alt = alt;
  img.loading = 'lazy';
  img.decoding = 'async';
  img.addEventListener('error', () => {
    if (fallback) img.replaceWith(fallback);
    else img.remove();
  }, { once: true });
  img.src = src;
  panel.append(img);
}
function createSizeChart(row, sizes) {
  const chart = node('div', 'detail-facts');
  const message = node('p', 'detail-note', 'Size measurements are unavailable.');
  const available = node('p');
  available.append(node('strong', '', 'Available sizes'), ' ' + sizes.join(' · '));
  chart.append(available);
  appendProductInfoImage(chart, row.sizeChart, row.name + ' size chart', message);
  return chart;
}
function createProductTabs(row, sizes) {
  const extras = row.extraImages ?? [];
  const photos = extras.length
    ? createGallery([row, ...extras.map((image) => ({ ...row, image, imageVariants: [] }))])
    : picture(row, 'detail-photo');
  const details = node('div', 'detail-facts');
  if (row.details) details.append(node('p', '', row.details));
  appendProductInfoImage(details, row.detailsImage, row.name + ' details');
  const facts = node('dl', 'product-facts');
  facts.append(
    node('dt', '', 'Colour'), node('dd', '', row.colour),
    node('dt', '', 'Available sizes'), node('dd', '', sizes.join(' · '))
  );
  details.append(facts);

  const media = node('div', 'detail-media');
  const tabs = node('div', 'product-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Product information');
  media.append(tabs);
  const views = [
    ['photos', 'Photos', photos],
    ['details', 'Details', details],
    ['size-chart', 'Size chart', createSizeChart(row, sizes)]
  ].map(([id, label, content], index) => {
    const tab = btn(label, 'product-tab', () => selectTab(index));
    tab.id = 'product-tab-' + id;
    tab.setAttribute('role', 'tab');
    const panel = node('div', 'product-panel');
    panel.id = 'product-panel-' + id;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    panel.tabIndex = 0;
    panel.append(content);
    tab.setAttribute('aria-controls', panel.id);
    tabs.append(tab);
    media.append(panel);
    return { tab, panel };
  });
  function selectTab(index) {
    activeProductTab = index;
    views.forEach(({ tab, panel }, position) => {
      const selectedTab = position === index;
      tab.tabIndex = selectedTab ? 0 : -1;
      tab.setAttribute('aria-selected', String(selectedTab));
      panel.hidden = !selectedTab;
    });
  }
  tabs.addEventListener('keydown', (event) => {
    const index = views.findIndex(({ tab }) => tab === event.target);
    const next = {
      ArrowLeft: (index + views.length - 1) % views.length,
      ArrowRight: (index + 1) % views.length,
      Home: 0,
      End: views.length - 1
    }[event.key];
    if (!Number.isInteger(next)) return;
    event.preventDefault();
    selectTab(next);
    views[next].tab.focus();
  });
  selectTab(activeProductTab);
  return media;
}
function renderProductLayout(rows, info) {
  const body = $('product-body');
  const product = rows[0];
  const sizes = rows.map((row) => row.size);
  const media = JSON.stringify([
    product.name, product.colour, sizes, product.image, product.imageVariants,
    product.extraImages, product.details, product.detailsImage, product.sizeChart
  ]);
  // Keep the selected tab and photo when the shopper changes size.
  if (activeProductMedia === media) {
    body.lastElementChild.replaceWith(info);
    return;
  }
  activeProductMedia = media;
  const header = node('header', 'detail-header');
  const title = node('h2', '', product.name);
  title.id = 'product-title';
  header.append(title, node('p', 'modal-sub', product.colour));
  body.replaceChildren(header, createProductTabs(product, sizes), info);
}
function renderProduct(rows) {
  if (!rows.some((s) => s.sku === selected))
    selected = rows.length === 1 ? rows[0].sku : '';
  const picked = rows.find((s) => s.sku === selected);
  const info = node('section', 'detail-info');
  info.append(
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
        if (!skusById.has(sku)) throw Error('This option is no longer listed.');
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
    setText($('bag-count'), String(count()));
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
  renderProductLayout(rows, info);
}
function begin(flow, items) {
  const pending = read(sessionStorage, DRAFT, null);
  if (pending?.sent && !pending.receipt) {
    location.assign('checkout.html');
    return;
  }
  const available = listedBagItems(items);
  if (!available.length) return;
  const draft = {
    flow,
    items: available.map((r) => ({ sku: r.sku, qty: r.qty })),
    id: crypto.randomUUID(),
    created: Date.now()
  };
  if (!save(sessionStorage, DRAFT, draft)) {
    toast('Allow browser storage to continue to checkout.');
    return;
  }
  location.assign('checkout.html');
}
function bagSignIn() {
  return btn('Sign in to sync your bag', 'text-btn', () =>
    location.assign('/api/auth/start?shop=1')
  );
}
let bagRefresh;
function refreshBag() {
  if (!configured || bagRefresh) return bagRefresh;
  const previous = JSON.stringify([bagSignedIn(), getBag()]);
  bagRefresh = syncBag().then((items) => {
    setText($('bag-count'), String(count()));
    if ($('bag').open && previous !== JSON.stringify([bagSignedIn(), items])) renderBag();
    if (items.some(({ sku }) => !skusById.has(sku))) void refresh();
  }).catch((error) => {
    if ($('bag').open) toast(error.message);
  }).finally(() => {
    bagRefresh = null;
  });
  return bagRefresh;
}
function renderBag() {
  const out = $('bag-body');
  out.replaceChildren();
  const bag = listedBagItems();
  if (!bag.length) {
    out.append(
      node('p', 'card-meta', 'Your bag is empty.'),
      btn('Browse merchandise', 'text-btn', () => {
        $('bag').close();
        location.hash = 'shop';
      })
    );
    if (configured && !bagSignedIn()) out.append(bagSignIn());
    return;
  }
  let total = 0;
  const itemCount = count(bag);
  for (const item of bag) {
    const row = skusById.get(item.sku);
    const amount = row.paise * item.qty;
    total += amount;
    const line = node('div', 'bag-item'),
      text = node('div');
    text.append(
      node('strong', '', row.name),
      node('p', 'line-meta', row.colour + ' / ' + row.size)
    );
    const control = node('div', 'control');
    for (const delta of [-1, 1]) {
      const b = btn(delta === 1 ? '+' : '−', '', async () => {
        await updateBag((current) => {
          const entry = current.find((r) => r.sku === item.sku);
          if (entry && (delta < 0 || (skusById.has(item.sku) && count(current) < catalog.limit)))
            entry.qty += delta;
          return current.filter((r) => r.qty > 0);
        });
        renderBag();
      });
      b.setAttribute(
        'aria-label',
        (delta === 1 ? 'Increase ' : 'Decrease ') + item.sku + ' quantity'
      );
      b.disabled = delta > 0 && itemCount >= catalog.limit;
      if (delta === 1) control.append(node('span', '', item.qty));
      control.append(b);
    }
    text.append(control);
    line.append(
      picture(row, 'thumb'),
      text,
      node('strong', '', money(amount))
    );
    out.append(line);
  }
  const totals = node('p', 'total');
  totals.append(node('span', '', 'Subtotal'), node('strong', '', money(total)));
  out.append(totals);
  const check = btn('Continue to checkout →', 'action navy', () =>
    begin('bag', getBag())
  );
  check.disabled = !allowsOrder() || itemCount > catalog.limit;
  out.append(check);
  if (configured && !bagSignedIn()) out.append(bagSignIn());
  if (itemCount > catalog.limit)
    out.append(
      node('p', 'status', 'Adjust the items in your bag before checkout.')
    );
}
$('open-bag').onclick = () => {
  renderBag();
  $('bag').showModal();
  void refresh();
  void refreshBag();
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
$('search').oninput = () => repaint();
$('type').onchange = () => repaint();
window.addEventListener('storage', (e) => {
  if (e.key === BAG) repaint(true);
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    void refreshBag();
    if (Date.now() - refreshTime > 15000) refresh();
  }
});
window.addEventListener('pageshow', (e) => {
  if (e.persisted) {
    void refreshBag();
    refresh();
  }
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

void refreshBag();
setInterval(() => {
  if (!document.hidden && bagSignedIn()) void refreshBag();
}, 30000);
