// Demo modu: Spotify olmadan oyunu denemek için uydurma şarkılar ve tarayıcıda üretilen melodiler.

import { cyrb53, shuffle } from './util.js';
import { FL, PL, AL, makeTrack } from './lib.js';

const FIRST = ['Gece', 'Limon', 'Sahil', 'Neon', 'Kırmızı', 'Uykusuz', 'Yağmurlu', 'Eski', 'Mavi', 'Sessiz', 'Tozlu', 'Son'];
const SECOND = ['Otobüsü', 'Rüzgârı', 'Balkon', 'Kaset', 'Durağı', 'Pazartesi', 'Vapuru', 'Sokağı', 'Radyosu', 'Yazı'];
const ARTISTS = ['Kuzey Feneri', 'Portakal Sokak', 'Deniz Altı Kulübü', 'Mor Kedi', 'Üç Buçuk', 'Lodos FM', 'Kâğıt Uçak', 'Balkon Orkestrası'];

const BASE = 36;
const CATALOG = [];
for (let i = 0; i < BASE; i++) {
  CATALOG.push({
    id: 'demo' + String(i).padStart(3, '0'),
    name: `${FIRST[i % FIRST.length]} ${SECOND[(i * 7 + 3) % SECOND.length]}`,
    artists: ARTISTS[(i * 5 + 1) % ARTISTS.length],
    dur: (150 + ((i * 37) % 90)) * 1000,
  });
}
// Aynı şarkının "single" baskıları: kimliği farklı, şarkı aynı. Eşleştirmeyi denemek için.
for (let i = 0; i < 6; i++) {
  const src = CATALOG[i * 5];
  CATALOG.push({ ...src, id: 'demo' + String(BASE + i).padStart(3, '0'), name: src.name + ' - Single Version' });
}

const BY_ID = new Map(CATALOG.map((t) => [t.id, t]));

export const isDemo = (id) => String(id).startsWith('demo');

export function demoMeta(id) {
  const t = BY_ID.get(id);
  return t ? { name: t.name, artists: t.artists, img: '', dur: t.dur } : null;
}

export function demoLibrary() {
  const count = 14 + Math.floor(Math.random() * 8);
  return shuffle(CATALOG.slice())
    .slice(0, count)
    .map((t, i) => ({ ...makeTrack(t), f: [FL, PL, AL][i % 3] }));
}

let ctx = null;
let master = null;

export function stopTone() {
  if (master) {
    const m = master;
    master = null;
    try {
      m.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.15);
      setTimeout(() => m.disconnect(), 300);
    } catch {}
  }
}

// Şarkı kimliğinden türetilen kısa bir döngü; her demo şarkısı kendine özgü çalar.
export function demoTone(id) {
  stopTone();
  try {
    ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch {
    return false;
  }
  let seed = cyrb53(id);
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const scale = [0, 3, 5, 7, 10, 12, 15];
  const root = 196 * 2 ** (Math.floor(rnd() * 8) / 12);
  const step = 0.2 + rnd() * 0.12;
  const pattern = Array.from({ length: 16 }, () => (rnd() < 0.72 ? scale[Math.floor(rnd() * scale.length)] : null));

  master = ctx.createGain();
  master.gain.value = 0.07;
  master.connect(ctx.destination);
  const t0 = ctx.currentTime + 0.05;
  const out = master;
  for (let bar = 0; bar < 14; bar++) {
    pattern.forEach((semi, i) => {
      const at = t0 + (bar * pattern.length + i) * step;
      if (i % 4 === 0) note(out, 'sine', root / 2, at, step * 3.5, 0.9);
      if (semi != null) note(out, 'triangle', root * 2 ** (semi / 12), at, step * 0.9, 0.6);
    });
  }
  return true;
}

function note(out, type, freq, at, len, vol) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(vol, at + 0.015);
  g.gain.exponentialRampToValueAtTime(0.001, at + len);
  osc.connect(g).connect(out);
  osc.start(at);
  osc.stop(at + len + 0.02);
}
