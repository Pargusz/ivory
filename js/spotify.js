// Spotify: sunucusuz giriş (Authorization Code + PKCE), kütüphane okuma, cihazda çalma.
// Token yalnızca bu tarayıcıda durur; hiçbir sunucuya gönderilmez.

import { ls, ss, uid, sleep, shuffle, skipSong } from './util.js';
import { FL, PL, AL, EX, MAX_TRACKS, makeTrack } from './lib.js';
import * as cloud from './cloud.js';

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';
const SCOPES = [
  'user-top-read',
  'user-read-recently-played',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read',
  'playlist-modify-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  // Sekme içi oynatıcı (Web Playback SDK) bu üçünü ister.
  'streaming',
  'user-read-email',
  'user-read-private',
].join(' ');

// Sınırlar yalnızca uç durumlar için: sıradan bir kütüphane bunlara takılmadan tümüyle okunur.
const MAX_PLAYLISTS = 200;
const PLAYLIST_PAGES = 10; // sayfa başına 50 liste
const PAGES_PER_PLAYLIST = 30; // sayfa başına 50 şarkı
const LIKED_PAGES = 80;
const ALBUM_PAGES = 20;

export class SpotifyError extends Error {
  constructor(status, message, reason) {
    super(message || 'Spotify hatası');
    this.status = status;
    this.reason = reason;
  }
}

let clientIds = [];
let saveListName = 'Ivory';
let auth = ls.get('auth');
let ownPlaylists = null;

export function init(ids, playlistName) {
  clientIds = (ids || []).map((s) => String(s || '').trim()).filter(Boolean);
  if (playlistName) saveListName = playlistName;
  if (auth && !clientIds[auth.idx]) logout();
}

export const configured = () => clientIds.length > 0;
export const groupCount = () => clientIds.length;
export const authed = () => !!auth?.refresh;
export const user = () => auth?.user || null;
// Eski girişlerde "streaming" izni yoktur; sekme içi oynatıcı için yeniden bağlanmak gerekir.
export const canStream = () => /\bstreaming\b/.test(auth?.scope || '');
export const group = () => auth?.idx ?? ls.get('group', 0);

// Spotify panelinde kayıtlı olması gereken adres: sitenin klasörü, sonunda / ile.
export function redirectUri() {
  return location.origin + location.pathname.replace(/[^/]*$/, '');
}

// forget: hesabı gerçekten değiştiriyorsa bu tarayıcıda kimin oynadığı da unutulur (yedeği
// başkasına vermemek için). Uygulamalar arası geçişte unutulmaz.
export function logout(forget = true) {
  auth = null;
  ownPlaylists = null;
  ls.del('auth');
  if (forget) ls.del('who');
}

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function login(idx, resume) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = uid(16);
  ls.set('pkce', { state, verifier, idx, resume, at: Date.now() });
  ls.set('group', idx);
  const params = new URLSearchParams({
    client_id: clientIds[idx],
    response_type: 'code',
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge: b64url(digest),
    scope: SCOPES,
    state,
  });
  location.assign(AUTH_URL + '?' + params);
}

async function tokenRequest(fields) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new SpotifyError(res.status, data.error_description || data.error || 'Token alınamadı');
  return data;
}

function storeToken(idx, data, previous) {
  auth = {
    idx,
    access: data.access_token,
    refresh: data.refresh_token || previous?.refresh,
    exp: Date.now() + (data.expires_in || 3600) * 1000,
    user: previous?.user || null,
    scope: data.scope ?? previous?.scope ?? '',
  };
  ls.set('auth', auth);
}

// Spotify'dan dönüşte adres çubuğundaki ?code=…'u token'a çevirir.
export async function handleCallback() {
  const q = new URLSearchParams(location.search);
  const code = q.get('code');
  const error = q.get('error');
  if (!code && !error) return null;
  const pk = ls.get('pkce');
  ls.del('pkce');
  history.replaceState(null, '', location.pathname + location.hash);
  if (!pk || pk.state !== q.get('state')) return { ok: false, error: 'state', resume: pk?.resume };
  if (error) return { ok: false, error, resume: pk.resume };
  try {
    const data = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      client_id: clientIds[pk.idx],
      code_verifier: pk.verifier,
    });
    storeToken(pk.idx, data, null);
    return { ok: true, resume: pk.resume };
  } catch (e) {
    return { ok: false, error: e.message, resume: pk.resume };
  }
}

let refreshing = null;

function refresh() {
  refreshing ||= (async () => {
    try {
      const data = await tokenRequest({ grant_type: 'refresh_token', refresh_token: auth.refresh, client_id: clientIds[auth.idx] });
      storeToken(auth.idx, data, auth);
    } catch (e) {
      if (e.status === 400 || e.status === 401) logout();
      throw new SpotifyError(401, 'Spotify oturumu sona erdi');
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export async function accessToken() {
  if (!auth) throw new SpotifyError(401, 'Spotify bağlı değil');
  if (Date.now() > auth.exp - 60000) await refresh();
  return auth.access;
}

// Spotify, bir uygulamadan (Client ID) kısa sürede çok istek gelince hepsini 429 ile reddeder ve
// ısrar edildikçe cezayı uzatır. Ne kadar bekleneceğini tarayıcıya söylemez (Retry-After başlığı
// okunamıyor). Bu yüzden: istekler seyreltilir, 429 gelince durulur ve bir süre hiç istek atılmaz.
const GAP_MS = 110; // iki isteğin başlangıcı arasındaki en kısa süre
const BLOCK_STEPS = [60, 120, 300, 600, 900]; // art arda engellenmede bekleme (saniye)
const QUOTA_BLOCK = 900; // uygulamanın kotası dolduysa (QUOTA_EXCEEDED) en az bu kadar beklenir
let nextSlot = 0;
// Sınır uygulama (Client ID) başınadır; her uygulamanın engeli ayrı tutulur.
let rates = ls.get('rates', {});
const myRate = () => rates[auth?.idx ?? 0] || { until: 0, level: 0 };

async function pace() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + GAP_MS;
  if (at > now) await sleep(at - now);
}

// Spotify bu siteyi şu an engelliyorsa kaç saniye sonra yeniden denenebileceği; yoksa 0.
export const blockedFor = () => Math.max(0, Math.ceil((myRate().until - Date.now()) / 1000));
// Engel kısa süreli bir yoğunluk değil, uygulamanın kotasının dolması mı? (Saatler sürebilir.)
export const quotaOut = () => !!myRate().quota && blockedFor() > 0;

function tooMany(quota) {
  const rate = myRate();
  const wait = Math.max(BLOCK_STEPS[Math.min(rate.level, BLOCK_STEPS.length - 1)], quota ? QUOTA_BLOCK : 0);
  rates = { ...rates, [auth?.idx ?? 0]: { until: Date.now() + wait * 1000, level: rate.level + 1, at: Date.now(), quota: !!quota } };
  ls.set('rates', rates);
}

function rateOk() {
  // Bir süredir sorunsuz gidiyorsa ceza basamağı sıfırlanır.
  const rate = myRate();
  if (rate.level && Date.now() - (rate.at || 0) > 20 * 60000) {
    rates = { ...rates };
    delete rates[auth?.idx ?? 0];
    ls.set('rates', rates);
  }
}

const rateError = () => new SpotifyError(429, 'Spotify çok fazla istek aldı', myRate().quota ? 'QUOTA' : 'RATE');

async function api(path, { method = 'GET', body, attempt = 0 } = {}) {
  if (!auth) throw new SpotifyError(401, 'Spotify bağlı değil');
  if (blockedFor()) throw rateError();
  if (Date.now() > auth.exp - 60000) await refresh();
  await pace();
  if (blockedFor()) throw rateError();
  const res = await fetch(path.startsWith('http') ? path : API + path, {
    method,
    headers: { Authorization: 'Bearer ' + auth.access, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && attempt < 1) {
    await refresh();
    return api(path, { method, body, attempt: attempt + 1 });
  }
  if (res.status === 429) {
    const quota = /QUOTA_EXCEEDED/.test(await res.text().catch(() => ''));
    // Kısa süreli yoğunlukta bir kez, biraz bekleyip yeniden dene; kota dolduysa hiç ısrar etme.
    if (!quota && attempt < 1 && !blockedFor()) {
      await sleep(2500);
      return api(path, { method, body, attempt: attempt + 1 });
    }
    if (!blockedFor()) tooMany(quota);
    throw rateError();
  }
  rateOk();
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) throw new SpotifyError(res.status, data?.error?.message || text || res.statusText, data?.error?.reason);
  return data;
}

function image(images) {
  if (!images?.length) return '';
  return (images.find((i) => i.width && i.width <= 320) || images[images.length > 1 ? 1 : 0]).url || '';
}

function add(map, t, flag, albumImg) {
  if (!t || !t.id || t.is_local || (t.type && t.type !== 'track')) return;
  // Spotify'dan kaldırılmış ya da bu ülkede çalınamayan şarkılar oyuna girmez.
  if (t.is_playable === false) return;
  if (skipSong(t.name, (t.artists || []).map((a) => a.name).join(','))) return;
  let e = map.get(t.id);
  if (!e) {
    e = makeTrack({
      id: t.id,
      name: t.name,
      artists: (t.artists || []).map((a) => a.name).filter(Boolean).join(', '),
      img: albumImg || image(t.album?.images),
      dur: t.duration_ms,
      isrc: t.external_ids?.isrc,
    });
    map.set(t.id, e);
  }
  e.f |= flag | (t.explicit ? EX : 0);
}

async function pool(items, size, worker) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await worker(queue.shift());
  }));
}

async function listOwnPlaylists(me) {
  const own = [];
  let url = '/me/playlists?limit=50';
  for (let page = 0; url && page < PLAYLIST_PAGES; page++) {
    const data = await api(url);
    for (const p of data.items || []) if (p?.owner?.id === me.id) own.push({ id: p.id, name: p.name });
    url = data.next;
  }
  ownPlaylists = own;
  return own;
}

async function playlistItems(id, each) {
  // Şubat 2026'dan beri uç nokta /items; eski uygulamalarda /tracks.
  let url = `/playlists/${id}/items?limit=50&market=from_token`;
  for (let page = 0; url && page < PAGES_PER_PLAYLIST; page++) {
    let data;
    try {
      data = await api(url);
    } catch (e) {
      if (page === 0 && (e.status === 404 || e.status === 400)) data = await api(`/playlists/${id}/tracks?limit=50&market=from_token`);
      else throw e;
    }
    for (const it of data.items || []) each(it.item || it.track);
    url = data.next;
  }
}

// Sitenin üç kaynağını okur: sık dinlenenler, oluşturduğu listeler, kayıtlı albümler.
// Bir kaynak hata verirse diğerleri yine yüklenir; hata `warn` içinde döner.
// Okunan kütüphane tarayıcıda 30 gün saklanır: Spotify'a yalnızca ilk girişte ve "Şarkıları
// yenile" (force) denince sorulur. Spotify istekleri reddediyorsa (kota) saklanan liste, süresi
// geçmiş olsa da kullanılır: oyun Spotify'ın kotasına takılmadan sürer.
const CACHE_MS = 30 * 24 * 3600 * 1000;
const CACHE_V = 4;

function keptLibrary() {
  const kept = ls.get('libcache');
  if (kept?.v === CACHE_V && kept.uid && kept.tracks?.length) return kept;
  // Kalıcı kayıt yoksa: bu sekmede daha önce okunmuş liste hâlâ duruyor olabilir (sekme
  // kapanana kadar saklanır). Yalnızca Spotify reddederse kullanılsın diye "eski" sayılır.
  const tab = ss.get('lib');
  if (tab?.mode === 'spotify' && tab.tracks?.length) {
    const found = { v: CACHE_V, uid: auth?.user?.id || 'tab', user: auth?.user || null, at: 0, tracks: tab.tracks };
    ls.set('libcache', found);
    return found;
  }
  return null;
}

// limited: Spotify'a ulaşılamadığı için saklanan liste kullanıldı.
function fromKept(kept, limited) {
  if (!auth.user || limited) {
    auth.user = kept.user || { id: kept.uid, name: '' };
    ls.set('auth', auth);
  }
  if (auth.user?.id && auth.user.id !== 'tab') ls.set('who', auth.user);
  return { user: auth.user, tracks: kept.tracks, warn: [], kept: kept.at, limited, cloud: !!kept.cloud };
}

// Buluttaki yedek (varsa) yerel kayda da alınır.
async function fromCloud(uid) {
  const got = await cloud.loadLib(uid);
  if (!got) return null;
  const kept = { v: CACHE_V, uid, user: got.user, at: got.at, tracks: got.tracks, cloud: true };
  ls.set('libcache', kept);
  return kept;
}

// Sıra: bu tarayıcıdaki kayıt → buluttaki yedek → Spotify. Spotify'a ancak ikisi de yoksa ya da
// "Şarkıları yenile" (force) dendiyse gidilir; Spotify reddederse yine kayda/yedeğe dönülür.
export async function loadLibrary(progress = () => {}, force = false) {
  const kept = keptLibrary();
  const fresh = (k) => k && Date.now() - k.at < CACHE_MS;
  // Yeniden giriş yapılmış olsa da bu tarayıcıda en son kimin oynadığı hatırlanır.
  const who = auth?.user?.id || ls.get('who')?.id;
  if (!force && fresh(kept) && kept.uid === who) return fromKept(kept, false);
  let backup = null;
  if (!force && who) {
    progress({ label: 'Yedek', count: 0 });
    backup = await fromCloud(who);
    if (fresh(backup)) return fromKept(backup, false);
  }
  try {
    return await readLibrary(progress, kept, force);
  } catch (e) {
    if (e.status !== 429) throw e;
    backup ||= who ? await fromCloud(who) : null;
    const best = backup && (!kept || backup.at >= kept.at) ? backup : kept;
    if (best) return fromKept(best, true);
    throw e;
  }
}

// Bu oyuncunun buluttaki ve tarayıcıdaki kayıtlı listesini siler.
export async function forgetLibrary() {
  const who = auth?.user?.id || ls.get('who')?.id;
  ls.del('libcache');
  return who ? cloud.dropLib(who) : false;
}

export const cloudOn = () => cloud.enabled();

async function readLibrary(progress, kept, force) {
  const me = await api('/me');
  auth.user = { id: me.id, name: me.display_name || me.id };
  ls.set('auth', auth);
  ls.set('who', auth.user);
  // Yeniden giriş yapıldıysa kim olduğu ancak şimdi belli olur; kayıtlı liste ya da yedek onunsa
  // yeniden okuma.
  if (!force) {
    if (kept && kept.uid === me.id && Date.now() - kept.at < CACHE_MS) return fromKept(kept, false);
    const backup = await fromCloud(me.id);
    if (backup && Date.now() - backup.at < CACHE_MS) return fromKept(backup, false);
  }

  const map = new Map();
  const warn = [];
  const step = async (label, fn) => {
    progress({ label, count: map.size });
    try {
      await fn();
    } catch (e) {
      if (e.status === 401) throw e;
      warn.push(label);
    }
    progress({ label, count: map.size });
  };

  await step('Sık dinlenenler', async () => {
    for (const range of ['short_term', 'medium_term', 'long_term']) {
      for (let offset = 0; offset < 100; offset += 50) {
        const page = await api(`/me/top/tracks?time_range=${range}&limit=50&offset=${offset}`);
        for (const t of page.items || []) add(map, t, FL);
        progress({ label: 'Sık dinlenenler', count: map.size });
        if (!page.next) break;
      }
    }
  });

  await step('Son çalınanlar', async () => {
    const page = await api('/me/player/recently-played?limit=50');
    for (const it of page.items || []) add(map, it.track, FL);
  });

  await step('Çalma listeleri', async () => {
    // Oyunda kaydedilen şarkıların listesi başkalarının şarkılarıyla dolu; onu sayma.
    const lists = (await listOwnPlaylists(me)).filter((p) => p.name !== saveListName).slice(0, MAX_PLAYLISTS);
    // Tek bir liste okunamazsa (silinmiş, kısıtlı) diğerleri yine okunsun.
    let failed = 0;
    await pool(lists, 4, async (p) => {
      try {
        await playlistItems(p.id, (t) => add(map, t, PL));
      } catch (e) {
        if (e.status === 401) throw e;
        failed++;
      }
      progress({ label: 'Çalma listeleri', count: map.size });
    });
    if (lists.length && failed === lists.length) throw new SpotifyError(0, 'listeler okunamadı');
  });

  // Beğenilen Şarkılar da oyuncunun kendi listesi sayılır.
  await step('Beğenilen şarkılar', async () => {
    const first = await api('/me/tracks?limit=50&market=from_token');
    for (const it of first.items || []) add(map, it.track, PL);
    const offsets = [];
    for (let o = 50; o < Math.min(first.total || 0, LIKED_PAGES * 50); o += 50) offsets.push(o);
    await pool(offsets, 4, async (o) => {
      const page = await api('/me/tracks?limit=50&market=from_token&offset=' + o);
      for (const it of page.items || []) add(map, it.track, PL);
      progress({ label: 'Beğenilen şarkılar', count: map.size });
    });
  });

  await step('Kayıtlı albümler', async () => {
    let url = '/me/albums?limit=50&market=from_token';
    for (let page = 0; url && page < ALBUM_PAGES; page++) {
      const data = await api(url);
      for (const it of data.items || []) {
        const img = image(it.album?.images);
        for (const t of it.album?.tracks?.items || []) add(map, { ...t, type: 'track' }, AL, img);
      }
      progress({ label: 'Kayıtlı albümler', count: map.size });
      url = data.next;
    }
  });

  let tracks = [...map.values()];
  if (tracks.length > MAX_TRACKS) {
    const top = tracks.filter((t) => t.f & FL);
    const rest = shuffle(tracks.filter((t) => !(t.f & FL)));
    tracks = top.concat(rest).slice(0, MAX_TRACKS);
  }
  // Okuma yarıda kesildiyse (kota) ve elde daha dolu bir kayıt varsa o kullanılır; yarım liste saklanmaz.
  if (warn.length && kept && kept.uid === auth.user.id && kept.tracks.length >= tracks.length) return fromKept(kept, blockedFor() > 0);
  if (!warn.length && tracks.length) {
    ls.set('libcache', { v: CACHE_V, uid: auth.user.id, user: auth.user, at: Date.now(), tracks });
    // Yedekleme arkada yapılır; başarısız olsa da oyun etkilenmez.
    cloud.saveLib(auth.user, tracks);
  }
  return { user: auth.user, tracks, warn };
}

export async function track(id) {
  const t = await api('/tracks/' + id + '?market=from_token');
  return {
    name: t.name,
    artists: (t.artists || []).map((a) => a.name).join(', '),
    img: image(t.album?.images),
    album: t.album?.name || '',
    dur: t.duration_ms || 0,
    gone: t.is_playable === false, // Spotify'dan kaldırılmış ya da bu ülkede çalınamıyor
  };
}

// "Şarkıyı bil" modundaki öneri listesi için.
export async function search(q) {
  const data = await api('/search?type=track&limit=8&q=' + encodeURIComponent(q));
  return (data?.tracks?.items || [])
    .filter(Boolean)
    .map((t) => ({ name: t.name, artists: (t.artists || []).map((a) => a.name).join(', ') }))
    .filter((t) => !skipSong(t.name, t.artists));
}

// Kapak bulmacasındaki öneri listesi için: sanatçı adları.
export async function searchArtists(q) {
  const data = await api('/search?type=artist&limit=6&q=' + encodeURIComponent(q));
  return (data?.artists?.items || []).filter(Boolean).map((a) => a.name);
}

export async function devices() {
  const data = await api('/me/player/devices');
  return (data?.devices || []).filter((d) => d.id && !d.is_restricted);
}

export const transfer = (id) => api('/me/player', { method: 'PUT', body: { device_ids: [id], play: false } });
export const play = (id, uri, positionMs) =>
  api('/me/player/play?device_id=' + encodeURIComponent(id), { method: 'PUT', body: { uris: [uri], position_ms: positionMs || 0 } });
export const pause = (id) => api('/me/player/pause' + (id ? '?device_id=' + encodeURIComponent(id) : ''), { method: 'PUT' });
export const volume = (id, percent) =>
  api('/me/player/volume?volume_percent=' + percent + (id ? '&device_id=' + encodeURIComponent(id) : ''), { method: 'PUT' });
export const playerState = () => api('/me/player');

// Çalan şarkıyı oyuncunun kendi "Ivory" listesine ekler; liste yoksa oluşturur.
export async function saveTrack(id) {
  const cacheKey = 'savelist.' + auth.user?.id;
  const uris = ['spotify:track:' + id];
  let listId = ls.get(cacheKey);
  if (listId) {
    try {
      await api(`/playlists/${listId}/items`, { method: 'POST', body: { uris } });
      return saveListName;
    } catch (e) {
      if (e.status !== 404 && e.status !== 403) throw e;
      ls.del(cacheKey);
    }
  }
  const me = auth.user || (await api('/me'));
  const own = ownPlaylists || (await listOwnPlaylists(me));
  listId = own.find((p) => p.name === saveListName)?.id;
  if (!listId) {
    const made = await api('/me/playlists', {
      method: 'POST',
      body: { name: saveListName, public: false, description: 'Ivory oyunlarında beğenip kaydettiğim şarkılar' },
    });
    listId = made.id;
    own.push({ id: listId, name: saveListName });
  }
  await api(`/playlists/${listId}/items`, { method: 'POST', body: { uris } });
  ls.set(cacheKey, listId);
  return saveListName;
}

// Girişsiz başlık + kapak: Spotify API yanıt vermezse yedek.
export async function publicMeta(id) {
  const res = await fetch('https://open.spotify.com/oembed?url=' + encodeURIComponent('https://open.spotify.com/track/' + id));
  if (!res.ok) throw new Error('oembed');
  const data = await res.json();
  return { name: data.title || '', artists: '', img: data.thumbnail_url || '', dur: 0 };
}
