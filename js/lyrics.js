// "Şarkıyı bil" modundaki söz ipuçları. Sözler lrclib.net'ten gelir (açık, anahtarsız);
// bulunamazsa oyun ipucusuz devam eder.

import { baseTitle } from './util.js';
import { GUESS_STEPS } from './host.js';

const API = 'https://lrclib.net/api';
const MIN_LINES = [0, 1, 3]; // aşama başına en az gösterilecek satır
const MAX_LINES = 4;
const QUIET_S = 6; // sözler bundan geç başlıyorsa şarkının başı tahmin için fazla sessiz sayılır
const LEAD_S = 1.5;
const cache = new Map();

function parse(rec) {
  if (!rec || rec.instrumental) return [];
  if (rec.syncedLyrics) {
    const out = [];
    for (const line of rec.syncedLyrics.split('\n')) {
      const m = line.match(/^\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/);
      if (m && m[3].trim()) out.push({ t: Number(m[1]) * 60 + Number(m[2]), text: m[3].trim() });
    }
    if (out.length) return out;
  }
  return String(rec.plainLyrics || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((text) => ({ t: null, text }));
}

async function get(path, params) {
  const res = await fetch(`${API}/${path}?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(7000) });
  return res.ok ? res.json() : null;
}

async function load(meta) {
  const artist = String(meta.artists || '').split(',')[0].trim();
  if (meta.dur) {
    const exact = parse(await get('get', { track_name: meta.name, artist_name: artist, duration: Math.round(meta.dur / 1000) }).catch(() => null));
    if (exact.length) return exact;
  }
  const found = (await get('search', { track_name: baseTitle(meta.name), artist_name: artist }).catch(() => null)) || [];
  const best = found.find((r) => r.syncedLyrics) || found.find((r) => r.plainLyrics);
  return parse(best);
}

export function lyrics(id, meta) {
  if (!meta?.name) return Promise.resolve([]);
  if (!cache.has(id)) cache.set(id, load(meta).catch(() => []));
  return cache.get(id);
}

// Kesitin başlayacağı yer (ms): girişi uzun şarkılarda sözlerin başladığı anın hemen öncesi.
// Zaman bilgili söz yoksa şarkı baştan çalar.
export function startAt(lines, dur) {
  const first = lines?.find((l) => l.t != null)?.t;
  if (first == null || first < QUIET_S) return 0;
  const at = Math.round((first - LEAD_S) * 1000);
  return dur && at > dur - 40000 ? 0 : at;
}

// Aşamaya göre gösterilecek satırlar: dinlenen kesitte geçenler, yoksa şarkının ilk satırları.
// Şarkının adındaki sözcükler gizlenir ki ipucu cevabı vermesin. `from`: kesitin başladığı saniye.
export function hintLines(lines, stage, title, from = 0) {
  // İlk aşama ipucusuzdur: kesit sözlerin başından çalabildiği için sözler cevabı ele verirdi.
  if (!lines?.length || !stage) return [];
  const heard = lines.filter((l) => l.t != null && l.t <= from + GUESS_STEPS[stage]);
  const picked = heard.length >= MIN_LINES[stage] ? heard.slice(-MAX_LINES) : lines.slice(0, MIN_LINES[stage]);
  const words = baseTitle(title)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const mask = words.length ? new RegExp(`(?<![\\p{L}\\p{N}])(${words.join('|')})(?![\\p{L}\\p{N}])`, 'giu') : null;
  return picked.map((l) => (mask ? l.text.replace(mask, '•••') : l.text));
}
