export function videoPath(value) {
  if (typeof value !== 'string' || value.length > 1500) return '';
  const path = value.trim().replace(/^\.\//, '');
  if (path.startsWith('assets/')) {
    try {
      const decoded = decodeURIComponent(path);
      const parts = decoded.split('/');
      return /^assets\/[A-Za-z0-9_ .()/\-]+\.mp4$/i.test(decoded) &&
        !parts.some((part) => !part || part === '.' || part === '..')
        ? parts.map(encodeURIComponent).join('/')
        : '';
    } catch {
      return '';
    }
  }
  if (/[\s\\<>"]/.test(path)) return '';
  try {
    const url = new URL(path);
    if (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.hash &&
      /\.mp4$/i.test(url.pathname)
    )
      return url.href;
  } catch {}
  return '';
}

export function homepageVideos(choices) {
  if (!Array.isArray(choices)) return [];
  const result = [], seen = new Set();
  for (const row of choices) {
    const desktop = videoPath(row?.desktop), mobile = videoPath(row?.mobile);
    if (!desktop || !mobile) continue;
    const key = JSON.stringify([desktop, mobile]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ desktop, mobile });
    if (result.length === 6) break;
  }
  return result;
}

export function setupHeroVideo() {
  const hero = document.getElementById('store-hero');
  const stage = document.getElementById('hero-stage');
  const video = document.getElementById('hero-video');
  const banners = document.getElementById('home-banners');
  const promotions = document.getElementById('hero-promotions');
  const grid = stage?.querySelector('.hero-grid');
  if (!hero || !stage || !video || !grid || !banners || !promotions)
    return () => {};

  const phone = matchMedia('(max-width: 680px)');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const connection = navigator.connection;
  const failed = new Set();
  let clips = [], key = '', current = 0, visible = true;

  function placeBanners(active) {
    hero.classList.toggle('hero--video', active);
    const parent = active ? promotions : grid;
    if (banners.parentElement !== parent) parent.append(banners);
  }

  function showBanners() {
    placeBanners(false);
    delete stage.dataset.videoReady;
    if (video.hasAttribute('src')) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
  }

  function updatePlayback() {
    const source = video.getAttribute('src');
    if (source && visible && !document.hidden) {
      void video.play().catch((error) => {
        if (error.name === 'NotAllowedError' && video.getAttribute('src') === source)
          showBanners();
      });
    } else {
      video.pause();
    }
  }

  function showClip() {
    const clip = clips[current];
    const source = clip && !reducedMotion.matches && !connection?.saveData &&
      failed.size < clips.length
      ? clip[phone.matches ? 'mobile' : 'desktop']
      : '';
    if (!source) {
      showBanners();
      return;
    }
    video.loop = clips.length - failed.size === 1;
    placeBanners(true);
    if (video.getAttribute('src') !== source) {
      delete stage.dataset.videoReady;
      video.muted = true;
      video.src = source;
    } else if (video.ended) {
      video.currentTime = 0;
    }
    updatePlayback();
  }

  function nextClip() {
    if (failed.size < clips.length) {
      do {
        current = (current + 1) % clips.length;
      } while (failed.has(current));
    }
    showClip();
  }

  function reset() {
    failed.clear();
    current = 0;
    showClip();
  }

  video.addEventListener('loadeddata', () => { stage.dataset.videoReady = ''; });
  video.addEventListener('ended', nextClip);
  video.addEventListener('error', () => {
    if (!video.error || !video.hasAttribute('src')) return;
    failed.add(current);
    nextClip();
  });
  phone.addEventListener('change', reset);
  reducedMotion.addEventListener('change', reset);
  connection?.addEventListener('change', reset);
  document.addEventListener('visibilitychange', updatePlayback);
  if ('IntersectionObserver' in window)
    new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      updatePlayback();
    }).observe(stage);

  return (rows) => {
    const next = homepageVideos(rows);
    const serialized = JSON.stringify(next);
    if (serialized === key) return;
    clips = next;
    key = serialized;
    reset();
  };
}
