import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { validateCatalogue } from '../server/catalogue.js';
import { callScript } from '../server/script-client.js';
import { saveDriveProductPhotos } from '../scripts/drive-product-photos.mjs';
import { googleFixture } from './google-fixture.mjs';

const photoID = 'merchandise-photo-a';
const otherID = 'merchandise-photo-b';
const folderID = 'product-photos';
const driveLink = (id) => 'https://drive.google.com/file/d/' + id + '/view?usp=drive_link';
const bytes = await readFile(
  new URL('../dist/assets/green-white-sweat-shirt-male.webp', import.meta.url)
);
const otherBytes = await readFile(
  new URL('../dist/assets/green-white-sweat-shirt-female.webp', import.meta.url)
);
function photoFile(content, folder, initialRevision = 1800000000000) {
  let readParent = false;
  return {
    revision: initialRevision,
    trashed: false,
    getParents() {
      readParent = false;
      return {
        hasNext: () => !readParent,
        next() {
          readParent = true;
          return { getId: () => folder };
        }
      };
    },
    isTrashed() { return this.trashed; },
    getMimeType: () => 'image/webp',
    getSize: () => content.length,
    getLastUpdated() { return new Date(this.revision); },
    getBlob: () => ({ getBytes: () => content })
  };
}
const request = (fixture, action, body) =>
  callScript(fixture.env, action, body, fixture.fetcher);

test('one existing SKU supplies an ordered gallery for all sizes of its colour', () => {
  const fixture = googleFixture();
  assert.equal(fixture.state.deployed.products[0].extraImages, undefined);
  fixture.state.choices[1] +=
    ' | assets/polo-white.png | https://photos.example/polo-back.webp | assets/detail.webp';
  const published = validateCatalogue(fixture.catalogue());
  assert.equal(published.ready, true);
  assert.equal(published.products[0].image, 'assets/polo-white.png');
  assert.deepEqual(published.products[0].extraImages, [
    'https://photos.example/polo-back.webp', 'assets/detail.webp'
  ]);
  assert.deepEqual(published.products[0].skus.map(({ size }) => size), ['M', 'L']);
  assert.equal(published.products[1].extraImages, undefined);
});

test('a single photo, details and a size chart are shared by the sizes of the same colour', () => {
  const fixture = googleFixture();
  fixture.state.choices = [
    'SWEAT-GREEN-S | Sweatshirt | Green | S | 899',
    'SWEAT-GREEN-M | Sweatshirt | Green | M | 899 | assets/front-and-back.webp' +
      ' | print=name,number | details=Cotton blend. Machine wash cold.' +
      ' | details-image=assets/merch details.webp' +
      ' | size-chart=assets/sweatshirt chart.webp',
    'SWEAT-RED-M | Sweatshirt | Red | M | 899 | details-image=missing details.webp | size-chart=missing chart.webp'
  ];
  const published = validateCatalogue(fixture.catalogue());
  assert.equal(published.ready, true);
  const [green, red] = published.products;
  assert.equal(green.image, 'assets/front-and-back.webp');
  assert.equal(green.details, 'Cotton blend. Machine wash cold.');
  assert.equal(green.detailsImage, 'assets/merch%20details.webp');
  assert.equal(green.sizeChart, 'assets/sweatshirt%20chart.webp');
  assert.deepEqual(green.skus.map(({ size }) => size), ['S', 'M']);
  assert.deepEqual(green.skus[1].printFields, ['name', 'number']);
  assert.equal(green.skus[0].printFields, undefined);
  assert.equal(red.detailsImage, undefined);
  assert.equal(red.sizeChart, undefined);
});

test('Drive images for the details and size chart are copied and repeated assets are shared', async () => {
  const fixture = googleFixture();
  fixture.props.PRODUCT_PHOTOS_FOLDER_ID = folderID;
  fixture.photos.set(photoID, photoFile(bytes, folderID));
  fixture.photos.set(otherID, photoFile(otherBytes, folderID));
  fixture.state.choices[0] += ' | size-chart=' + driveLink(photoID) + ' | details-image=' + driveLink(otherID);
  fixture.state.choices[2] += ' | ' + driveLink(photoID);
  const result = await request(fixture, 'catalogue', {});
  const snapshot = validateCatalogue(result.data);
  const path = snapshot.products[0].sizeChart;
  const detailsPath = snapshot.products[0].detailsImage;
  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.products[1].extraImages[0], path);
  assert.equal(result.data.photoAssets.length, 2);
  assert.deepEqual(
    new Set(result.data.photoAssets.map(({ src }) => src)),
    new Set([path, detailsPath])
  );
  const directory = await mkdtemp(join(tmpdir(), 'marc-size-chart-'));
  try {
    const output = pathToFileURL(directory + '/');
    await saveDriveProductPhotos(
      result.data.photoAssets, snapshot.products, output,
      (photo) => request(fixture, 'productPhoto', photo)
    );
    assert.deepEqual(await readFile(new URL(path, output)), bytes);
    assert.deepEqual(await readFile(new URL(detailsPath, output)), otherBytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Drive photos are included in the static build with their own bytes and no Drive IDs', async () => {
  const fixture = googleFixture();
  fixture.props.PRODUCT_PHOTOS_FOLDER_ID = folderID;
  fixture.photos.set(photoID, photoFile(bytes, folderID));
  fixture.photos.set(otherID, photoFile(otherBytes, folderID));
  fixture.state.choices[0] +=
    ' | assets/polo-white.png | ' + driveLink(photoID) + ' | ' + driveLink(otherID);

  const result = await request(fixture, 'catalogue', {});
  const snapshot = validateCatalogue(result.data);
  assert.equal(snapshot.ready, true);
  assert.equal(result.data.photoAssets.length, 2);
  const paths = snapshot.products[0].extraImages;
  assert.deepEqual(paths, result.data.photoAssets.map(({ src }) => src));
  assert.equal(JSON.stringify(snapshot).includes(photoID), false);
  assert.equal('photoAssets' in snapshot, false);

  const directory = await mkdtemp(join(tmpdir(), 'marc-product-photos-'));
  try {
    const output = pathToFileURL(directory + '/');
    await saveDriveProductPhotos(
      result.data.photoAssets, snapshot.products, output,
      (photo) => request(fixture, 'productPhoto', photo)
    );
    assert.deepEqual(await readFile(new URL(paths[0], output)), bytes);
    assert.deepEqual(await readFile(new URL(paths[1], output)), otherBytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a Drive edit requests a build and the old revision cannot supply new bytes', async () => {
  const fixture = googleFixture();
  fixture.props.PRODUCT_PHOTOS_FOLDER_ID = folderID;
  const file = photoFile(bytes, folderID);
  fixture.photos.set(photoID, file);
  fixture.state.choices[0] += ' | assets/polo-white.png | ' + driveLink(photoID);
  fixture.script.installCatalogueSync();
  assert.equal(fixture.state.redeploys, 1);
  const before = fixture.catalogue();
  fixture.state.deployed = validateCatalogue(before);
  fixture.script.publishCatalogueIfChanged();
  assert.equal(fixture.state.redeploys, 1);
  file.revision += 1000;
  fixture.script.publishCatalogueIfChanged();
  fixture.script.publishCatalogueIfChanged();
  assert.equal(fixture.state.redeploys, 2);
  const after = fixture.catalogue();
  assert.notEqual(before.version, after.version);
  assert.notEqual(before.photoAssets[0].src, after.photoAssets[0].src);
  const outdated = await request(fixture, 'productPhoto', before.photoAssets[0]);
  assert.equal(outdated.ok, false);
});

test('Drive access stays within the photo folder and a skipped photo leaves sales open', async () => {
  const fixture = googleFixture();
  const privateFile = photoFile(bytes, fixture.props.SCREENSHOT_FOLDER_ID);
  fixture.photos.set(photoID, privateFile);
  fixture.props.PRODUCT_PHOTOS_FOLDER_ID = folderID;
  fixture.state.choices[0] += ' | assets/polo-white.png | ' + driveLink(photoID);
  const live = await request(fixture, 'catalogue', {});
  assert.equal(live.data.ready, true);
  assert.equal(live.data.photoAssets, undefined);
  assert.equal(live.data.products[0].image, 'assets/polo-white.png');
  assert.equal(live.data.products[0].extraImages, undefined);
  const lookup = { id: photoID, revision: privateFile.revision };
  assert.equal((await request(fixture, 'productPhoto', lookup)).ok, false);
  fixture.props.PRODUCT_PHOTOS_FOLDER_ID = fixture.props.SCREENSHOT_FOLDER_ID;
  assert.equal((await request(fixture, 'productPhoto', lookup)).ok, false);
});
