// Build steps that only touch files in dist/ (no network), so they can be tested.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

// Keep these in step with market-core.js (photo, picture and validImageVariants).
const variantWidths = [480, 768, 960, 1152, 1536];
const variantPattern = /^assets\/optimized\/[a-f0-9]{20}-(480|768|960|1152|1536)\.webp$/;
const bannerSizes = '(max-width: 680px) 92vw, (max-width: 1568px) 50vw, 770px';
const cardSizes = '(max-width: 680px) 36vw, (max-width: 950px) 24vw, 260px';

// Files with a content hash in their name can be cached for a year. A file is
// listed after every file it imports.
const hashedAssets = ['hero-video.js', 'market-core.js', 'market.js', 'upi-apps.js', 'checkout.js', 'market.css', 'order-progress.css'];
const pages = ['index.html', 'checkout.html', 'privacy.html', 'marc-rules.html'];

export function photoPath(src) {
  if (!src) return '';
  const path = src.replace(/^\.\//, '');
  const match = path.match(/^assets\/polo-(white|maroon)(?:-480)?\.(?:png|webp)(?:\?.*)?$/);
  if (match) return 'assets/polo-' + match[1] + '-480.webp';
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

const attr = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function usableVariants(variants) {
  return Array.isArray(variants)
    ? variants.filter(
        (v) =>
          variantWidths.includes(v?.width) &&
          typeof v.src === 'string' &&
          variantPattern.test(v.src) &&
          v.src.endsWith('-' + v.width + '.webp')
      )
    : [];
}

// The storefront draws its first banner (or, without banners, the first product
// photo) from JavaScript, so the browser can't discover that image until the
// scripts run. A preload in the HTML starts it alongside the CSS instead.
export function lcpPreload(snapshot) {
  const banner = (snapshot.homepageBanners || []).find(
    (b) => b && typeof b.image === 'string' && photoPath(b.image) && typeof b.title === 'string'
  );
  const product = snapshot.products?.[0];
  const target = banner
    ? { image: banner.image, variants: banner.imageVariants, sizes: bannerSizes }
    : product?.image
      ? { image: product.image, variants: product.imageVariants, sizes: cardSizes }
      : null;
  if (!target) return '';
  const variants = usableVariants(target.variants);
  if (variants.length)
    return (
      '<link rel="preload" as="image" imagesrcset="' +
      attr(variants.map((v) => v.src + ' ' + v.width + 'w').join(', ')) +
      '" imagesizes="' + attr(target.sizes) + '" fetchpriority="high" />'
    );
  const href = photoPath(target.image);
  return href
    ? '<link rel="preload" as="image" href="' + attr(href) + '" fetchpriority="high" />'
    : '';
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Matches a quoted reference such as "market.js?v=16" or './market-core.js'.
const reference = (name) =>
  new RegExp('(["\'/])' + escapeRegExp(name) + '(?:\\?v=[\\w.-]*)?(?=["\'])', 'g');

export async function versionAssets(output) {
  const renamed = {};
  const rewrite = (text) =>
    Object.entries(renamed).reduce(
      (out, [name, hashed]) => out.replace(reference(name), (_, lead) => lead + hashed),
      text
    );
  for (const name of hashedAssets) {
    const source = rewrite(await readFile(new URL(name, output), 'utf8'));
    const hash = createHash('sha256').update(source).digest('hex').slice(0, 10);
    const hashed = name.replace(/\.(js|css)$/, '.' + hash + '.$1');
    await writeFile(new URL(hashed, output), source);
    renamed[name] = hashed;
  }
  for (const page of pages) {
    const file = new URL(page, output);
    const html = await readFile(file, 'utf8').catch(() => null);
    if (html !== null) await writeFile(file, rewrite(html));
  }
  return renamed;
}

export async function finishBuild(output, snapshot) {
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
      html
        .replace(
          /(<script id="catalogue-snapshot" type="application\/json">)[\s\S]*?(<\/script>)/,
          (_, start, end) => start + inline + end
        )
        .replace('<!-- marc:lcp-preload -->', () => lcpPreload(snapshot))
    )
  ]);
  return versionAssets(output);
}
