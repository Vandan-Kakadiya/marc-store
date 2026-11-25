import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateCatalogue } from '../server/catalogue.js';
import { callScript } from '../server/script-client.js';
import { googleFixture } from './google-fixture.mjs';

const winter = {
  desktop: 'assets/videos/marc-winter-desktop-walk.mp4',
  mobile: 'assets/videos/marc-winter-mobile-walk.mp4'
};
const winterOption = winter.desktop + ' | ' + winter.mobile;

test('the Form publishes responsive video pairs in the order entered', async () => {
  const store = googleFixture();
  assert.equal(validateCatalogue(store.catalogue()).homepageVideos, undefined);
  store.state.videoChoices = [
    winterOption,
    'https://media.example/store.mp4?version=2 | ./assets/Videos/phone edit.mp4'
  ];
  const response = await callScript(store.env, 'catalogue', {}, store.fetcher);
  assert.equal(response.ok, true);
  const snapshot = validateCatalogue(response.data);
  assert.equal(snapshot.ready, true);
  assert.deepEqual(snapshot.homepageVideos, [
    winter,
    { desktop: 'https://media.example/store.mp4?version=2', mobile: 'assets/Videos/phone%20edit.mp4' }
  ]);
});

test('invalid video rows stay out of the catalogue while products and banners publish', () => {
  const store = googleFixture();
  store.state.bannerChoices = ['assets/campaign.webp | Campaign'];
  store.state.videoChoices = [
    'assets/videos/desktop.mp4',
    'assets/../desktop.mp4 | assets/videos/phone.mp4',
    'http://example.com/video.mp4 | assets/videos/phone.mp4',
    'https://drive.google.com/file/d/example/view?title=film.mp4 | assets/videos/phone.mp4',
    'assets/videos/desktop.webp | assets/videos/phone.mp4',
    winterOption,
    winterOption
  ];
  const snapshot = validateCatalogue(store.catalogue());
  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.homepageBanners.length, 1);
  assert.deepEqual(snapshot.homepageVideos, [winter]);
  assert.deepEqual(validateCatalogue({
    ...snapshot,
    homepageVideos: [{ ...winter, desktop: 'https://name:pass@example.com/video.mp4' }, winter]
  }).homepageVideos, [winter]);
});

test('adding and removing video options changes the existing deployment snapshot', () => {
  const store = googleFixture();
  store.script.installCatalogueSync();
  assert.equal(store.state.redeploys, 0);
  store.state.videoChoices = [winterOption];
  store.script.publishCatalogueIfChanged();
  store.script.publishCatalogueIfChanged();
  assert.equal(store.state.redeploys, 1);
  store.state.deployed = validateCatalogue(store.catalogue());
  store.script.publishCatalogueIfChanged();
  assert.equal(store.state.redeploys, 1);

  store.state.videoChoices = [];
  store.script.publishCatalogueIfChanged();
  assert.equal(store.state.redeploys, 2);
  assert.equal(validateCatalogue(store.catalogue()).homepageVideos, undefined);
});
