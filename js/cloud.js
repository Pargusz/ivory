// Şarkı listelerinin yedeği: Firebase Realtime Database (site sahibinin projesi, config.js).
// Bir oyuncunun kütüphanesi bir kez okunduktan sonra burada durur; başka cihazdan girse ya da
// tarayıcısını temizlese de Spotify'a yeniden yüzlerce istek atılmaz. Yedek olmadan da her şey
// çalışır: buradaki her hata sessizce "yedek yok" sayılır.

import { ls } from './util.js';

const CFG = window.IVORY_CONFIG?.firebase || {};
const IMG = 'https://i.scdn.co/image/';
let session = ls.get('fb'); // anonim Firebase oturumu: { id, refresh, exp }

export const enabled = () => !!CFG.databaseURL;

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('firebase auth');
  return res.json();
}

// Kurallar giriş istiyorsa kullanılacak anonim oturum. Projede anonim giriş kapalıysa boş döner
// ve istekler oturumsuz gider.
async function token() {
  if (!CFG.apiKey) return '';
  if (session && Date.now() < session.exp - 60000) return session.id;
  try {
    if (session?.refresh) {
      const d = await post('https://securetoken.googleapis.com/v1/token?key=' + CFG.apiKey, { grant_type: 'refresh_token', refresh_token: session.refresh });
      session = { id: d.id_token, refresh: d.refresh_token, exp: Date.now() + Number(d.expires_in) * 1000 };
    } else {
      const d = await post('https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + CFG.apiKey, { returnSecureToken: true });
      session = { id: d.idToken, refresh: d.refreshToken, exp: Date.now() + Number(d.expiresIn) * 1000 };
    }
    ls.set('fb', session);
    return session.id;
  } catch {
    session = null;
    ls.del('fb');
    return '';
  }
}

// Spotify kullanıcı kimliği veritabanı anahtarında yasak karakter içerebilir; güvenli hâle getirilir.
const keyOf = (uid) => btoa(unescape(encodeURIComponent(uid))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function call(uid, method, body) {
  const t = await token();
  const res = await fetch(`${CFG.databaseURL}/libs/${keyOf(uid)}.json${t ? '?auth=' + t : ''}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error('firebase ' + res.status);
  return res.json();
}

// Şarkılar yer kaplamasın diye satır satır tutulur: [id, bayrak, süre, ad, sanatçılar, kapak, anahtar, isrc].
const pack = (t) => [t.id, t.f, t.dur || 0, t.name || '', t.artists || '', String(t.img || '').replace(IMG, '~'), t.key || '', t.ik || ''];
const unpack = ([id, f, dur, name, artists, img, key, ik]) => ({ id, f, dur, name, artists, img: String(img || '').replace(/^~/, IMG), key, ik });

export async function saveLib(user, tracks) {
  if (!enabled() || !user?.id || !tracks?.length) return false;
  try {
    await call(user.id, 'PUT', { at: Date.now(), name: user.name || '', n: tracks.length, t: JSON.stringify(tracks.map(pack)) });
    return true;
  } catch {
    return false;
  }
}

// { at, user, tracks } ya da yedek yoksa null.
export async function loadLib(uid) {
  if (!enabled() || !uid) return null;
  try {
    const d = await call(uid, 'GET');
    const tracks = d?.t ? JSON.parse(d.t).map(unpack) : [];
    return tracks.length ? { at: d.at || 0, user: { id: uid, name: d.name || '' }, tracks } : null;
  } catch {
    return null;
  }
}

export async function dropLib(uid) {
  if (!enabled() || !uid) return false;
  try {
    // Güvenlik kuralları boş yazmaya (silmeye) izin vermediği için kaydın içi boşaltılır:
    // şarkılar ve ad gider, geriye boş bir kabuk kalır.
    await call(uid, 'PUT', { at: Date.now(), name: '', n: 0, t: '[]' });
    return true;
  } catch {
    return false;
  }
}
