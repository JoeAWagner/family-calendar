// iCloud Shared Album (public) photo source.
//
// When you enable "Public Website" on a shared album in Apple Photos, iCloud
// serves a public JSON feed (the same API the web viewer uses) — no login.
// We read the photo list + signed derivative URLs and hand them to the
// screensaver. Signed URLs expire (~1h), so we refresh them transparently.

// Accepts a full share URL or a bare token, e.g.
//   https://www.icloud.com/sharedalbum/#B0GNq2...   ->  token B0GNq2...
function parseToken(raw) {
  if (!raw) return '';
  const s = raw.trim();
  if (s.includes('#')) return s.split('#').pop();
  if (s.startsWith('http')) return s.split('/').filter(Boolean).pop();
  return s;
}
const TOKEN = parseToken(process.env.ICLOUD_ALBUM || '');

export const albumConfigured = () => !!TOKEN;

const STREAM_TTL = 30 * 60 * 1000; // re-list photos every 30 min (picks up new ones)
const ASSET_TTL = 45 * 60 * 1000;  // refresh signed URLs before they expire (~1h)

let streamCache = { at: 0, host: null, photos: [] }; // photos: [{ guid, checksum }]
let assetCache = { at: 0, urls: {} };                // checksum -> full url

function post(host, endpoint, body) {
  return fetch(`https://${host}/${TOKEN}/sharedstreams/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      Origin: 'https://www.icloud.com',
      Referer: 'https://www.icloud.com/',
    },
    body: JSON.stringify(body),
  });
}

async function loadStream() {
  // iCloud partitions albums across hosts; start anywhere and follow the 330 redirect.
  let host = 'p42-sharedstreams.icloud.com';
  let res = await post(host, 'webstream', { streamCtag: null });
  if (res.status === 330) {
    const j = await res.json();
    host = j['X-Apple-MMe-Host'] || host;
    res = await post(host, 'webstream', { streamCtag: null });
  }
  if (!res.ok) throw new Error(`webstream HTTP ${res.status}`);
  const data = await res.json();
  const photos = [];
  for (const p of data.photos || []) {
    if (p.mediaAssetType && p.mediaAssetType !== 'image') continue; // skip videos
    // Pick the largest derivative (best quality for a wall display).
    let best = null;
    for (const d of Object.values(p.derivatives || {})) {
      if (!d.checksum) continue;
      if (!best || (Number(d.width) || 0) > (Number(best.width) || 0)) best = d;
    }
    if (best) photos.push({ guid: p.photoGuid, checksum: best.checksum });
  }
  streamCache = { at: Date.now(), host, photos };
  return streamCache;
}

async function ensureStream() {
  if (Date.now() - streamCache.at < STREAM_TTL && streamCache.photos.length) return streamCache;
  return loadStream();
}

async function loadAssets() {
  const { host, photos } = await ensureStream();
  const urls = {};
  const guids = photos.map((p) => p.guid);
  for (let i = 0; i < guids.length; i += 25) { // iCloud caps the batch size
    const res = await post(host, 'webasseturls', { photoGuids: guids.slice(i, i + 25) });
    if (!res.ok) continue;
    const j = await res.json();
    for (const [checksum, info] of Object.entries(j.items || {})) {
      urls[checksum] = `https://${info.url_location}${info.url_path}`;
    }
  }
  assetCache = { at: Date.now(), urls };
  return assetCache;
}

async function ensureAssets() {
  if (Date.now() - assetCache.at < ASSET_TTL && Object.keys(assetCache.urls).length) return assetCache;
  return loadAssets();
}

// Ordered list of photo GUIDs (the frontend requests them via /photo/:guid).
export async function listGuids() {
  const s = await ensureStream();
  return s.photos.map((p) => p.guid);
}

// A currently-valid signed URL for one photo (refreshes the cache if expired).
export async function urlForGuid(guid) {
  const s = await ensureStream();
  const photo = s.photos.find((p) => p.guid === guid);
  if (!photo) return null;
  let assets = await ensureAssets();
  if (!assets.urls[photo.checksum]) assets = await loadAssets();
  return assets.urls[photo.checksum] || null;
}
