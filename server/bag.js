import { accountKey } from './account-store.js';
import { fail, orderPattern, skuPattern } from './common.js';

function bagView(key, entry) {
  return {
    owner: key,
    version: entry?.version ?? null,
    items: (entry?.value.items ?? []).map(([sku, qty]) => ({ sku, qty }))
  };
}

export async function readBag(accounts, env, buyer) {
  const key = accountKey(env, buyer);
  return bagView(key, await accounts.read('bag', key));
}

export async function writeBag(accounts, env, buyer, body) {
  const key = accountKey(env, buyer);
  if (body.owner !== key) fail(401, 'Sign in again to update your account bag.');
  if (!orderPattern.test(body.change || '') || !Array.isArray(body.items) || body.items.length > 100)
    fail(400, 'Check the items in your bag.');
  const items = new Map();
  for (const row of body.items) {
    if (!row || typeof row.sku !== 'string' || !skuPattern.test(row.sku) || items.has(row.sku) ||
        !Number.isInteger(row.qty) || row.qty < 1 || row.qty > 100)
      fail(400, 'Check the items in your bag.');
    items.set(row.sku, row.qty);
  }

  const current = await accounts.read('bag', key);
  const changes = current?.value.changes ?? [];
  if (changes.includes(body.change)) return bagView(key, current);
  const version = current?.version ?? null;
  if (version !== body.version) fail(409, 'Your bag was updated. Try again.');
  const saved = await accounts.write('bag', key, {
    items: [...items],
    changes: [...changes.slice(-19), body.change]
  }, version);
  if (!saved) fail(409, 'Your bag was updated. Try again.');
  return bagView(key, saved);
}
