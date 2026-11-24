import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createAccountStore } from '../server/account-store.js';
import { orderPattern, proofLimit, sha256Pattern, skuPattern } from '../server/common.js';
import { database } from '../server/database.js';
import { enqueueOrder, orderFingerprint, queueKey } from '../server/order-queue.js';
import { createOrderQueue } from '../server/queue-store.js';

async function filesIn(directory, extension) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => entry.name).sort();
}

async function importOrders(queue, directory, filenames, env) {
  if (filenames.length && !sha256Pattern.test(env.MARC_SCRIPT_SECRET || ''))
    throw Error('Set MARC_SCRIPT_SECRET to the existing MARC script secret.');
  let count = 0;
  for (const filename of filenames) {
    const key = filename.slice(0, -4);
    if (!sha256Pattern.test(key)) throw Error('Keep each original pending .bin filename.');
    const value = await readFile(join(directory, filename));
    const end = value.indexOf(10, 65);
    if (value[64] !== 10 || end <= 65 || end > 210000)
      throw Error('Invalid queue file ' + filename);
    const fingerprint = value.toString('ascii', 0, 64);
    const metadata = value.toString('utf8', 65, end);
    const order = JSON.parse(metadata);
    const proof = value.subarray(end + 1);
    if (!orderPattern.test(order.id || '') || typeof order.buyer !== 'string' ||
        !['image/png', 'image/jpeg', 'image/webp'].includes(order.proof?.mime) ||
        !proof.length || proof.length > proofLimit || orderFingerprint(metadata, proof) !== fingerprint ||
        queueKey(env, order) !== key)
      throw Error('Could not verify queue file ' + filename);
    const saved = await enqueueOrder(queue, key, order, proof, metadata);
    if (!saved.pending && !saved.ok)
      throw Error('Could not import ' + filename + ' (' + saved.code + '). Keep the original file.');
    count++;
  }
  return count;
}

async function importBags(accounts, directory, filenames) {
  let count = 0;
  for (const filename of filenames) {
    const key = filename.slice(0, -5);
    if (!sha256Pattern.test(key)) throw Error('Keep each original bag .json filename.');
    const bag = JSON.parse(await readFile(join(directory, filename), 'utf8'));
    if (!Array.isArray(bag.items) || bag.items.length > 100 ||
        !bag.items.every((item) => Array.isArray(item) && item.length === 2 &&
          typeof item[0] === 'string' && skuPattern.test(item[0]) &&
          Number.isInteger(item[1]) && item[1] >= 1 && item[1] <= 100))
      throw Error('Invalid bag file ' + filename);
    const items = [...new Map(bag.items)];
    const changes = Array.isArray(bag.changes)
      ? bag.changes.filter((change) => typeof change === 'string' && orderPattern.test(change)).slice(-20)
      : [];
    if (await accounts.write('bag', key, { items, changes }, null)) count++;
  }
  return count;
}

async function main(root, env) {
  if (!root || !env.DATABASE_URL) throw Error('Supply the export folder and set DATABASE_URL.');
  const pendingDirectory = join(root, 'pending'), bagDirectory = join(root, 'bag');
  const [pending, bags] = await Promise.all([filesIn(pendingDirectory, '.bin'), filesIn(bagDirectory, '.json')]);
  if (!pending.length && !bags.length) throw Error('Add pending/*.bin or bag/*.json files to the export folder.');
  const pool = database(env);
  try {
    const orders = await importOrders(createOrderQueue(env, pool), pendingDirectory, pending, env);
    const addedBags = await importBags(createAccountStore(env, fetch, pool), bagDirectory, bags);
    console.log('Pending orders verified in PostgreSQL ' + orders + '. Account bags added ' + addedBags + '.');
  } finally {
    await pool.end();
  }
}

try {
  await main(process.argv[2], process.env);
} catch (error) {
  console.error(error.code ? 'Import stopped (' + error.code + '). Keep the original files.' : error.message);
  process.exitCode = 1;
}
