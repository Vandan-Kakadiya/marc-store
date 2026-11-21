import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

const photoLimit = 4 * 1024 * 1024;
const assetPattern = /^assets\/catalogue\/[a-f0-9]{24}\.(jpg|png|webp)$/;
const mimeTypes = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

function matchesImage(bytes, format) {
  if (format === 'jpg')
    return bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
  if (format === 'png')
    return bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return (
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WEBP'
  );
}

export async function saveDriveProductPhotos(assets, products, output, fetchPhoto) {
  const needed = new Set(
    products
      .flatMap((product) => [product.image, ...(product.extraImages ?? [])])
      .filter((src) => assetPattern.test(src))
  );
  if (!Array.isArray(assets) || assets.length !== needed.size)
    throw Error('The catalogue is missing Google Drive photo details.');
  if (!assets.length) return;

  const requests = assets.map((asset) => {
    const { id, revision, src } = asset ?? {};
    const format = typeof src === 'string' && assetPattern.exec(src)?.[1];
    if (
      !format ||
      !needed.delete(src) ||
      typeof id !== 'string' ||
      !/^[A-Za-z0-9_-]{10,128}$/.test(id) ||
      !Number.isSafeInteger(revision)
    )
      throw Error('The catalogue contains invalid Google Drive photo details.');
    const hash = createHash('sha256')
      .update(id + ':' + revision)
      .digest('hex')
      .slice(0, 24);
    if (src !== 'assets/catalogue/' + hash + '.' + format)
      throw Error('The Google Drive photo path does not match its revision.');
    return { id, revision, src, format };
  });

  await mkdir(new URL('assets/catalogue/', output), { recursive: true });
  // Limit simultaneous requests to the existing Apps Script web app.
  for (let index = 0; index < requests.length; index += 4) {
    await Promise.all(
      requests.slice(index, index + 4).map(async ({ id, revision, src, format }) => {
        const result = await fetchPhoto({ id, revision });
        const data = result?.data;
        if (
          !result?.ok ||
          data?.mime !== mimeTypes[format] ||
          typeof data?.content !== 'string' ||
          data.content.length > Math.ceil(photoLimit / 3) * 4
        )
          throw Error('Could not read a product photo from Google Drive.');
        const bytes = Buffer.from(data.content, 'base64');
        if (bytes.length > photoLimit || !matchesImage(bytes, format))
          throw Error('A Google Drive product photo has an invalid file format.');
        await writeFile(new URL(src, output), bytes);
      })
    );
  }
}
