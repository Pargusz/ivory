// Oyuncunun şarkı kütüphanesi: kaynak bayrakları ve host'a gönderilen sıkıştırılmış biçim.

import { songKey, isrcKey } from './util.js';

export const FL = 1; // sık dinlenenler (en çok + son çalınanlar)
export const PL = 2; // oyuncunun oluşturduğu çalma listeleri
export const AL = 4; // kayıtlı albümler
export const EX = 8; // explicit

export const SOURCES = [
  { bit: FL, label: 'Sık dinlenenler', short: 'sık dinlediği' },
  { bit: PL, label: 'Oluşturduğu listeler', short: 'kendi listesinde' },
  { bit: AL, label: 'Kayıtlı albümler', short: 'kayıtlı albümünde' },
];

const CHUNK = 180;
export const MAX_TRACKS = 3000;

export function makeTrack({ id, name = '', artists = '', img = '', dur = 0, isrc = '' }) {
  return { id, name, artists, img, dur, f: 0, key: songKey(name, artists), ik: isrcKey(isrc) };
}

// Bir parça: id.bayrak.süre.başlıkAnahtarı.isrcAnahtarı
export function encodeLib(tracks) {
  const chunks = [];
  let cur = [];
  for (const t of tracks) {
    cur.push([t.id, t.f.toString(32), Math.round((t.dur || 0) / 1000).toString(36), t.key || '', t.ik || ''].join('.'));
    if (cur.length === CHUNK) {
      chunks.push(cur.join(','));
      cur = [];
    }
  }
  if (cur.length) chunks.push(cur.join(','));
  return chunks;
}

export function decodeChunk(text) {
  const out = [];
  for (const part of String(text || '').split(',')) {
    const [id, f, dur, key, ik] = part.split('.');
    if (!id) continue;
    const keys = [];
    if (key) keys.push('t:' + key);
    if (ik) keys.push('i:' + ik);
    out.push({ id, f: parseInt(f, 32) || 0, dur: (parseInt(dur, 36) || 0) * 1000, keys });
  }
  return out;
}
