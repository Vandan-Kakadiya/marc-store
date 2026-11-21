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
  picture,
  read,
  save
} from './market-core.js?v=5';
let catalog = cachedCatalogue(),
  bag = getBag(),
  busy = false,
  seenLive = false,
  noticed = '',
  selected = '',
  activeGroup = '',
  refreshTime = 0;
let toastTimer;
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
const count = () => bag.reduce((n, r) => n + r.qty, 0);
const allowsOrder = () => configured && catalog.open;
const toast = (message) => {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  toastTimer = setTimeout(() => ($('toast').textContent = ''), 3000);
};
async function updateBag(reduce) {
  try {
    bag = await changeBag(reduce);
    $('bag-count').textContent = count();
    return true;
  } catch (e) {
    toast(e.message);
    return false;
  }
}
function repaint() {
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
  renderProduct(rows);
  $('product').showModal();
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
    ),
    node('p', 'option-label', 'Size / option')
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
  const actions = node('div', 'buyline');
  const add = btn('Add to bag', 'action outline', async () => {
    const sku = selected;
    if (
      await updateBag((items) => {
        if (items.reduce((n, r) => n + r.qty, 0) >= catalog.limit)
          throw Error('Your bag has reached the order limit.');
        const line = items.find((r) => r.sku === sku);
        if (line) line.qty++;
        else items.push({ sku, qty: 1 });
        return items;
      })
    ) {
      $('product').close();
      toast('Added to your bag.');
    }
  });
  const buy = btn('Buy now', 'action orange', () =>
    begin('buy-now', [{ sku: selected, qty: 1 }])
  );
  add.disabled = !picked || !allowsOrder() || count() >= catalog.limit;
  buy.disabled = !picked || !allowsOrder();
  actions.append(add, buy);
  info.append(
    sizes,
    actions,
    node(
      'small',
      '',
      !configured
        ? 'Preview only'
        : !allowsOrder()
          ? 'Ordering is paused.'
          : 'Maximum ' + catalog.limit + ' items per order.'
    )
  );
  $('product-body').replaceChildren(picture(row, 'detail-photo'), info);
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
          if (
            entry &&
            (delta < 0 ||
              current.reduce((n, r) => n + r.qty, 0) < catalog.limit)
          )
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
repaint();
refresh();
