import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateCatalogue } from '../server/catalogue.js';
import { callScript } from '../server/script-client.js';
import { googleFixture } from './google-fixture.mjs';

test('optional Homepage banners are published in Form order', async () => {
  const store = googleFixture();
  assert.equal(store.catalogue().homepageBanners, undefined);

  store.state.bannerChoices = [
    'assets/green-white-sweat-shirt-male.webp | Green and white sweatshirt | #shop',
    'https://photos.example/red.webp | Red sweatshirt | https://marc.example/#shop'
  ];
  const result = await callScript(store.env, 'catalogue', {}, store.fetcher);
  const published = validateCatalogue(result.data);
  assert.equal(published.ready, true);
  assert.deepEqual(published.homepageBanners, [
    { image: 'assets/green-white-sweat-shirt-male.webp', title: 'Green and white sweatshirt', href: '#shop' },
    { image: 'https://photos.example/red.webp', title: 'Red sweatshirt', href: 'https://marc.example/#shop' }
  ]);

  store.state.bannerChoices = [];
  assert.equal(validateCatalogue(store.catalogue()).homepageBanners, undefined);
});

test('invalid or repeated banner rows do not pause the catalogue', () => {
  const store = googleFixture();
  store.state.bannerChoices = [
    'assets/../test.png | Invalid path',
    'assets/blue.webp | Blue banner | invalid-link',
    'https://drive.google.com/file/d/example12345/view | Drive link',
    'assets/red.webp | Red banner',
    'assets/red.webp | Red banner repeated'
  ];
  const snapshot = validateCatalogue(store.catalogue());
  assert.equal(snapshot.ready, true);
  assert.deepEqual(snapshot.homepageBanners, [
    { image: 'assets/red.webp', title: 'Red banner', href: '#shop' }
  ]);
});

test('a banner-only Form edit triggers a deployment through the existing sync', () => {
  const store = googleFixture();
  store.script.installCatalogueSync();
  assert.equal(store.state.redeploys, 0);
  store.state.bannerChoices = ['assets/campaign.webp | Campaign'];
  store.script.publishCatalogueIfChanged();
  store.script.publishCatalogueIfChanged();
  assert.equal(store.state.redeploys, 1);
  assert.notEqual(store.catalogue().version, store.state.deployed.version);

  store.state.deployed = validateCatalogue(store.catalogue());
  store.script.publishCatalogueIfChanged();
  assert.equal(store.state.redeploys, 1);
});
