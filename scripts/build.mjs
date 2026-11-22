import { createHash } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { siteURL } from '../server/common.js';
import { callScript } from '../server/script-client.js';
import { validateCatalogue } from '../server/catalogue.js';
import { saveDriveProductPhotos } from './drive-product-photos.mjs';

const output = new URL('../dist/', import.meta.url);
const manifest = JSON.parse(
  await readFile(new URL('./image-variants.json', import.meta.url), 'utf8')
);
const site = siteURL(process.env.MARC_SITE_URL);

async function addImageVariants(row) {
  const image =
    site && row.image.startsWith(site + '/')
      ? row.image.slice(site.length + 1)
      : row.image;
  const entry = manifest[image];
  if (!entry) return row;
  try {
    const original = await readFile(new URL(image, output));
    // A replaced photo should use its new original until its variants are rebuilt.
    if (createHash('sha256').update(original).digest('hex') !== entry.sha256)
      return row;
    await Promise.all(
      entry.variants.map(({ src }) => access(new URL(src, output)))
    );
    return { ...row, imageVariants: entry.variants };
  } catch {
    return row;
  }
}

const result = await callScript(process.env, 'catalogue', {}, fetch, 55000);
if (!result.ok)
  throw Error(
    'Could not synchronize catalogue. Check the Apps Script deployment and property setup.'
  );
const snapshot = validateCatalogue(result.data);
await saveDriveProductPhotos(
  result.data.photoAssets ?? [],
  snapshot.products,
  output,
  (photo) => callScript(process.env, 'productPhoto', photo)
);
snapshot.products = await Promise.all(snapshot.products.map(addImageVariants));
if (snapshot.homepageBanners)
  snapshot.homepageBanners = await Promise.all(snapshot.homepageBanners.map(addImageVariants));
const json = JSON.stringify(snapshot);
const index = new URL('index.html', output);
const html = await readFile(index, 'utf8');
// Keep unusually large catalogues on the existing fetch path.
const inline =
  Buffer.byteLength(json) <= 64000 ? json.replace(/</g, '\\u003c') : '';
await Promise.all([
  writeFile(new URL('catalogue.json', output), json + '\n'),
  writeFile(
    index,
    html.replace(
      /(<script id="catalogue-snapshot" type="application\/json">)[\s\S]*?(<\/script>)/,
      (_, start, end) => start + inline + end
    )
  )
]);
console.log(
  'MARC catalogue saved. ' +
    snapshot.products.length +
    ' products, ' +
    (snapshot.ready ? 'ordering open' : 'ordering paused') +
    '.'
);
