// Ortak yardımcılar.

export const $ = (sel, root = document) => root.querySelector(sel);

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export function uid(n = 8) {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (const b of crypto.getRandomValues(new Uint8Array(n))) s += abc[b % abc.length];
  return s;
}

// Oda kodu: sesli söylemesi kolay 6 harf (I, O, Q, W, X yok).
export const CODE_ABC = 'ABCDEFGHJKLMNPRSTUVYZ';
export const CODE_LEN = 6;

export function makeCode() {
  let s = '';
  for (const b of crypto.getRandomValues(new Uint8Array(CODE_LEN))) s += CODE_ABC[b % CODE_ABC.length];
  return s;
}

export function cleanCode(raw) {
  return [...String(raw || '').toUpperCase()].filter((c) => CODE_ABC.includes(c)).join('').slice(0, CODE_LEN);
}

export function cleanName(raw) {
  return String(raw || '').replace(/[~<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 14);
}

export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function storage(area) {
  return {
    get(key, fallback = null) {
      try {
        const v = area.getItem('ivory.' + key);
        return v == null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        area.setItem('ivory.' + key, JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    },
    del(key) {
      try {
        area.removeItem('ivory.' + key);
      } catch {}
    },
  };
}

export const ls = storage(window.localStorage);
export const ss = storage(window.sessionStorage);

// Arka plandaki sekmelerde zamanlayıcılar kısılır; Worker'dan gelen tik kısılmaz.
// Oyun saati (tur süresi, kalp atışı, yeniden bağlanma) bu tike bağlı.
const tickers = new Set();
let ticking = false;

export function onTick(fn) {
  tickers.add(fn);
  if (!ticking) {
    ticking = true;
    const fire = () => {
      const now = Date.now();
      for (const f of tickers) {
        try {
          f(now);
        } catch (e) {
          console.error(e);
        }
      }
    };
    try {
      const src = URL.createObjectURL(new Blob(['setInterval(()=>postMessage(0),250)'], { type: 'text/javascript' }));
      new Worker(src).onmessage = fire;
    } catch {
      setInterval(fire, 250);
    }
  }
  return () => tickers.delete(fn);
}

export function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// Başlıktaki ek, aynı kaydın başka bir baskısını mı (single, albüm, remaster…) yoksa
// gerçekten farklı bir kaydı mı (canlı, remix, akustik…) gösteriyor?
const SAME_RECORDING = /feat|ft\.|with\b|remaster|version|versiyon|edit\b|mono|stereo|deluxe|bonus|explicit|clean|single|album|original|\b(19|20)\d\d\b/;
const OTHER_RECORDING = /live|canl[ıi]|konser|acoustic|akustik|remix|rmx|instrumental|enstr[uü]mantal|karaoke|demo|cover|sped|slowed|nightcore|reverb|orchestral|unplugged/;
const isNoise = (s) => !OTHER_RECORDING.test(s) && SAME_RECORDING.test(s);
export const squash = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i').replace(/[^a-z0-9]+/g, '');

export function baseTitle(name) {
  let t = String(name || '').toLowerCase();
  t = t.replace(/\s*[(\[]([^)\]]*)[)\]]/g, (whole, inner) => (isNoise(inner) ? '' : whole));
  const dash = t.match(/^(.+?)\s+-\s+(.+)$/);
  if (dash && isNoise(dash[2])) t = dash[1];
  return t.trim();
}

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

// Yazılan tahmin şarkının adı mı? Büyük/küçük harf, Türkçe karakter, noktalama, "(Remastered)"
// gibi ekler ve bir iki harflik yazım hatası sayılmaz; sanatçı adını eklemek de sorun değildir.
export function titleMatch(guess, name, artists) {
  const g = squash(String(guess || '').toLowerCase());
  if (!g) return false;
  const raw = String(name || '').toLowerCase();
  const bare = raw.replace(/\s*[(\[][^)\]]*[)\]]/g, '').replace(/\s+-\s+.*$/, '');
  const artist = squash(String(artists || '').toLowerCase().split(',')[0]);
  for (const v of new Set([squash(baseTitle(name)), squash(raw), squash(bare)])) {
    if (!v) continue;
    const slack = v.length <= 4 ? 0 : v.length <= 8 ? 1 : v.length <= 14 ? 2 : 3;
    if (editDistance(g, v) <= slack) return true;
    if (artist && (g === artist + v || g === v + artist)) return true;
    if (v.length >= 6 && g.includes(v)) return true;
  }
  return false;
}

// İki sanatçı listesinde ortak bir isim var mı? Öneri listesinden seçilen şarkının, aynı adı
// taşıyan başka bir sanatçının şarkısı olmadığını anlamak için.
export function artistMatch(a, b) {
  const names = (s) => String(s || '').toLowerCase().split(',').map(squash).filter(Boolean);
  const other = names(b);
  return names(a).some((x) => other.includes(x));
}

// Aynı şarkının single ve albüm sürümleri farklı Spotify kimliği taşır.
// Başlık + ilk sanatçıdan türetilen bu anahtar onları tek şarkı olarak eşleştirir.
export function songKey(name, artist) {
  const title = squash(baseTitle(name));
  if (!title) return '';
  const first = squash(String(artist || '').toLowerCase().split(',')[0]);
  return cyrb53(title + '|' + first).toString(36);
}

// ISRC aynı kaydı tanımlar; single ve albümde çoğu zaman ortaktır.
export const isrcKey = (isrc) => (isrc ? cyrb53(String(isrc).toUpperCase().replace(/[^A-Z0-9]/g, '')).toString(36) : '');

// Altın açıyla dağıtılan tonlar: art arda katılan oyuncular birbirinden uzak renk alır.
export const hueAt = (i) => Math.round((18 + i * 137.508) % 360);

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {}
    ta.remove();
    return ok;
  }
}
