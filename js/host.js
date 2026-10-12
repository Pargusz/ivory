// Oyun motoru. Odayı kuran kişinin tarayıcısında çalışır ve tek doğru kaynaktır:
// oyuncuları, kütüphaneleri, turları ve puanları tutar; her değişiklikte odanın tam
// durumunu yayınlar. Oyuncular yalnızca son durumu çizer, bu yüzden kaçan bir mesaj
// ya da sayfa yenileme oyunu bozmaz.

import { FL, PL, AL, EX, decodeChunk } from './lib.js';
import { uid, shuffle, pick, cleanName, hueAt } from './util.js';

const PRESENCE_MS = 12000;
const HEARTBEAT_MS = 2500;
const VOTE_GRACE_MS = 2500;
const COUNTDOWN_MS = 5000;
const EVENT_MS = 6000;
const SHARED_BIAS = 0.35;
const RIGHT = 3;
const WRONG = -1;

export const WIN_OPTIONS = [15, 30, 50, 75];
export const TIME_OPTIONS = [15, 30, 45, 60];
export const DEFAULT_SETTINGS = { src: FL | PL | AL, win: 30, time: 30, mid: true, ex: true };

function buildLib(chunks) {
  const map = new Map();
  const keys = new Map();
  for (const chunk of chunks) {
    for (const e of decodeChunk(chunk)) {
      map.set(e.id, e);
      for (const k of e.keys) {
        if (keys.has(k)) keys.get(k).push(e.f);
        else keys.set(k, [e.f]);
      }
    }
  }
  return { map, keys };
}

export class HostGame {
  constructor({ code, me, chunks, rev, send, resolveMeta, onState, onConflict, maxPlayers, minPlayers, saved }) {
    this.code = code;
    this.meId = me.id;
    this.send = send;
    this.resolveMeta = resolveMeta;
    this.onState = onState;
    this.onConflict = onConflict;
    this.max = maxPlayers || 24;
    this.min = minPlayers || 2;
    this.inst = uid(6);
    this.since = Date.now();
    this.v = 0;
    this.phase = 'lobby';
    this.set = { ...DEFAULT_SETTINGS };
    this.players = new Map();
    this.libs = new Map();
    this.kicked = new Set();
    this.round = null;
    this.next = null;
    this.used = new Set();
    this.rot = [];
    this.rotI = 0;
    this.rn = 0; // tur kimliği: oyunlar arasında da artar
    this.no = 0; // oyun içindeki şarkı sırası
    this.win = null;
    this.cd = 0;
    this.ev = null;
    this.dirty = true;
    this.lastCast = 0;
    this.closed = false;
    if (saved) this.#restore(saved);

    let host = this.players.get(me.id);
    if (!host) {
      host = this.#addPlayer(me.id, me.name, me.mode);
    }
    host.on = true;
    host.mode = me.mode;
    this.setOwnLib(chunks, rev, me.count);
  }

  // ---- gelen mesajlar ----

  handle(m) {
    if (this.closed || !m) return;
    if (m.t === 'st') {
      // Aynı odayı yöneten başka bir sekme var: yeni açılan devralır.
      if (m.inst !== this.inst && m.since > this.since) {
        this.closed = true;
        this.onConflict?.();
      }
      return;
    }
    if (m.t === 'hi') return this.#hi(m);
    const p = this.players.get(m.f);
    if (!p) return;
    if (m.f !== this.meId) this.#seen(p);
    if (m.t === 'lib') this.#lib(m);
    else if (m.t === 'v') this.#vote(p, m);
    else if (m.t === 'c') this.#cont(p, m);
    else if (m.t === 'sv') this.#saved(p);
    else if (m.t === 'bye') this.#remove(p.id);
  }

  setOwnLib(chunks, rev, count) {
    const p = this.players.get(this.meId);
    p.n = count;
    p.lt = chunks.length;
    p.lr = rev;
    this.libs.set(this.meId, { rev, total: chunks.length, chunks: chunks.slice(), got: chunks.length, ready: true, ...buildLib(chunks) });
    this.dirty = true;
  }

  #seen(p) {
    p.last = Date.now();
    if (!p.on) {
      p.on = true;
      this.dirty = true;
    }
  }

  #hi(m) {
    if (m.f === this.meId) return;
    if (this.kicked.has(m.f)) {
      this.send({ t: 'x', to: m.f, why: 'kick' });
      return;
    }
    let p = this.players.get(m.f);
    if (!p) {
      const name = cleanName(m.name) || 'Oyuncu';
      // Sekmesini kapatıp yeniden giren oyuncu: aynı isimli kopuk kaydı devralır, puanı kalır.
      const ghost = [...this.players.values()].find((q) => !q.on && q.id !== this.meId && q.name.toLowerCase() === name.toLowerCase());
      if (ghost) {
        this.#rebind(ghost, m.f);
        p = ghost;
      } else {
        if (this.players.size >= this.max) {
          this.send({ t: 'x', to: m.f, why: 'full' });
          return;
        }
        p = this.#addPlayer(m.f, name, m.mode);
      }
    }
    this.#seen(p);
    if (p.mode !== m.mode || p.n !== m.n || p.lt !== m.lt || p.lr !== m.lr) {
      p.mode = m.mode;
      p.n = m.n | 0;
      p.lt = m.lt | 0;
      if (p.lr !== m.lr) this.libs.delete(p.id);
      p.lr = m.lr;
      this.dirty = true;
    }
  }

  #addPlayer(id, rawName, mode) {
    let name = cleanName(rawName) || 'Oyuncu';
    const taken = new Set([...this.players.values()].map((q) => q.name.toLowerCase()));
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${cleanName(rawName).slice(0, 12)} ${i}`;
    const slots = new Set([...this.players.values()].map((q) => q.slot));
    let slot = 0;
    while (slots.has(slot)) slot++;
    const p = { id, name, slot, hue: hueAt(slot), sc: 0, on: true, last: Date.now(), mode: mode || 'none', n: 0, lt: 0, lr: '' };
    this.players.set(id, p);
    this.rot.splice(Math.floor(Math.random() * (this.rot.length + 1)), 0, id);
    this.dirty = true;
    return p;
  }

  #rebind(p, newId) {
    const old = p.id;
    this.players.delete(old);
    p.id = newId;
    this.players.set(newId, p);
    this.libs.delete(old);
    p.lr = '';
    this.rot = this.rot.map((x) => (x === old ? newId : x));
    const r = this.round;
    if (r) {
      const swap = (list) => list.map((x) => (x === old ? newId : x));
      r.ls = swap(r.ls);
      r.cont = swap(r.cont);
      const votes = {};
      for (const [voter, ballot] of Object.entries(r.votes)) votes[voter === old ? newId : voter] = swap(ballot);
      r.votes = votes;
      if (r.dl && old in r.dl) {
        r.dl[newId] = r.dl[old];
        delete r.dl[old];
      }
    }
    this.dirty = true;
  }

  #remove(id) {
    if (id === this.meId || !this.players.has(id)) return;
    this.players.delete(id);
    this.libs.delete(id);
    this.rot = this.rot.filter((x) => x !== id);
    if (this.round) this.round.ls = this.round.ls.filter((x) => x !== id);
    this.dirty = true;
  }

  #lib(m) {
    let lib = this.libs.get(m.f);
    if (!lib || lib.rev !== m.r) {
      lib = { rev: m.r, total: m.n | 0, chunks: [], got: 0, ready: false, map: new Map(), keys: new Map() };
      this.libs.set(m.f, lib);
    }
    if (lib.ready || lib.chunks[m.i] != null || m.i >= lib.total) return;
    lib.chunks[m.i] = String(m.d || '');
    lib.got++;
    if (lib.got === lib.total) {
      Object.assign(lib, buildLib(lib.chunks));
      lib.ready = true;
    }
    this.dirty = true;
  }

  #vote(p, m) {
    const r = this.round;
    if (this.phase !== 'vote' || !r || m.r !== r.n || r.votes[p.id]) return;
    r.votes[p.id] = [...new Set(Array.isArray(m.b) ? m.b : [])].filter((id) => this.players.has(id));
    this.dirty = true;
  }

  #cont(p, m) {
    const r = this.round;
    if (this.phase !== 'reveal' || !r || m.r !== r.n || r.cont.includes(p.id)) return;
    r.cont.push(p.id);
    this.dirty = true;
  }

  #saved(p) {
    this.ev = { id: uid(5), k: 'sv', who: p.name, until: Date.now() + EVENT_MS };
    this.dirty = true;
  }

  // ---- şarkı seçimi ----

  #allowed(f) {
    return !!(f & this.set.src) && (this.set.ex || !(f & EX));
  }

  // Şarkıyı dinleyenler: aynı Spotify kimliği, aynı kayıt (ISRC) ya da aynı başlık + sanatçı.
  // Böylece birinde single, diğerinde albüm sürümü olsa da ikisi de dinleyen sayılır.
  #listeners(entry) {
    const out = [];
    for (const id of this.players.keys()) {
      const lib = this.libs.get(id);
      if (!lib?.ready) continue;
      const same = lib.map.get(entry.id);
      if ((same && this.#allowed(same.f)) || entry.keys.some((k) => lib.keys.get(k)?.some((f) => this.#allowed(f)))) out.push(id);
    }
    return out;
  }

  #fresh(e) {
    return this.#allowed(e.f) && !this.used.has(e.id) && !e.keys.some((k) => this.used.has(k));
  }

  // Sırayla her oyuncudan bir şarkı: kütüphanesi büyük olan oyunu ele geçirmesin.
  // Oyuncunun içinden de önce kaynak, sonra şarkı seçilir ki az sayıdaki "sık dinlenenler"
  // binlerce liste şarkısının arasında kaybolmasın.
  #pick() {
    const order = this.rot.filter((id) => this.players.has(id));
    for (let k = 0; k < order.length; k++) {
      const at = (this.rotI + k) % order.length;
      const lib = this.libs.get(order[at]);
      if (!lib?.ready) continue;
      const buckets = new Map();
      for (const e of lib.map.values()) {
        if (!this.#fresh(e)) continue;
        for (const bit of [FL, PL, AL]) {
          if (!(e.f & bit) || !(this.set.src & bit)) continue;
          if (buckets.has(bit)) buckets.get(bit).push(e);
          else buckets.set(bit, [e]);
        }
      }
      if (!buckets.size) continue;
      const bucket = pick([...buckets.values()]);
      let chosen = pick(bucket);
      if (Math.random() < SHARED_BIAS) {
        const shared = shuffle(bucket.slice()).slice(0, 150).find((e) => this.#listeners(e).length > 1);
        if (shared) chosen = shared;
      }
      this.rotI = (at + 1) % order.length;
      return chosen;
    }
    return null;
  }

  // Sıradaki şarkıyı önceden seçip kapak/başlık bilgisini arka planda getirir;
  // tur başladığında herkes bekleme olmadan görür.
  #prepare() {
    if (this.next) return;
    const e = this.#pick();
    if (!e) return;
    this.used.add(e.id);
    for (const k of e.keys) this.used.add(k);
    const next = (this.next = { id: e.id, keys: e.keys, dur: e.dur, meta: null });
    Promise.resolve(this.resolveMeta(e.id))
      .then((meta) => {
        if (!meta) return;
        next.meta = meta;
        if (this.round?.id === next.id && !this.round.meta) {
          this.round.meta = meta;
          this.dirty = true;
        }
      })
      .catch(() => {});
  }

  #startRound() {
    this.#prepare();
    const t = this.next;
    this.next = null;
    if (!t) {
      this.#finish(true);
      return;
    }
    const dur = t.dur || t.meta?.dur || 0;
    const t0 = Date.now() + 300;
    this.round = {
      n: ++this.rn,
      no: ++this.no,
      id: t.id,
      meta: t.meta,
      pos: this.set.mid ? (dur ? Math.floor(dur / 2) : 45000) : 0,
      t0,
      t1: t0 + this.set.time * 1000,
      ls: this.#listeners(t),
      votes: {},
      cont: [],
      dl: null,
    };
    this.phase = 'vote';
    this.dirty = true;
  }

  #reveal() {
    const r = this.round;
    const listeners = new Set(r.ls);
    r.dl = {};
    for (const p of this.players.values()) {
      const ballot = r.votes[p.id];
      if (!ballot) continue;
      let delta = 0;
      for (const id of ballot) delta += listeners.has(id) ? RIGHT : WRONG;
      r.dl[p.id] = delta;
      p.sc += delta;
    }
    this.phase = 'reveal';
    this.dirty = true;
    if (!this.#leaders().reached) this.#prepare();
  }

  #leaders() {
    let top = -Infinity;
    for (const p of this.players.values()) top = Math.max(top, p.sc);
    return { top, reached: top >= this.set.win, ids: [...this.players.values()].filter((p) => p.sc === top).map((p) => p.id) };
  }

  #advance() {
    if (this.#leaders().reached) this.#finish(false);
    else this.#startRound();
  }

  #finish(outOfSongs) {
    this.win = { ids: this.#leaders().ids, out: !!outOfSongs };
    this.phase = 'won';
    this.next = null;
    this.dirty = true;
  }

  // ---- host'un yaptıkları ----

  setSettings(patch) {
    if (this.phase !== 'lobby') return;
    const s = { ...this.set, ...patch };
    s.src &= FL | PL | AL;
    if (!s.src) return;
    if (!WIN_OPTIONS.includes(s.win) || !TIME_OPTIONS.includes(s.time)) return;
    s.mid = !!s.mid;
    s.ex = !!s.ex;
    this.set = s;
    this.dirty = true;
  }

  songCount() {
    let n = 0;
    for (const lib of this.libs.values()) {
      if (!lib.ready) continue;
      for (const e of lib.map.values()) if (this.#allowed(e.f)) n++;
    }
    return n;
  }

  canStart() {
    if ([...this.players.values()].filter((p) => p.on).length < this.min) return { ok: false, why: `En az ${this.min} oyuncu gerekli` };
    if (!this.songCount()) return { ok: false, why: 'Seçili kaynaklarda hiç şarkı yok' };
    return { ok: true };
  }

  start() {
    if ((this.phase !== 'lobby' && this.phase !== 'won') || !this.canStart().ok) return false;
    for (const p of this.players.values()) p.sc = 0;
    this.used.clear();
    this.round = null;
    this.next = null;
    this.win = null;
    this.no = 0;
    shuffle(this.rot);
    this.rotI = 0;
    this.phase = 'countdown';
    this.cd = Date.now() + COUNTDOWN_MS;
    this.#prepare();
    this.dirty = true;
    return true;
  }

  kick(id) {
    if (id === this.meId || !this.players.has(id)) return;
    this.kicked.add(id);
    this.#remove(id);
    this.send({ t: 'x', to: id, why: 'kick' });
  }

  toLobby() {
    if (this.phase !== 'won') return;
    this.phase = 'lobby';
    this.round = null;
    this.win = null;
    this.dirty = true;
  }

  close() {
    this.closed = true;
    this.send({ t: 'x', why: 'closed' });
  }

  // ---- saat ----

  tick(now) {
    if (this.closed) return;
    for (const p of this.players.values()) {
      if (p.id === this.meId) continue;
      const on = now - p.last < PRESENCE_MS;
      if (on !== p.on) {
        p.on = on;
        this.dirty = true;
      }
    }
    const active = [...this.players.values()].filter((p) => p.on);
    const r = this.round;
    if (this.phase === 'countdown') {
      if (now >= this.cd) this.#startRound();
    } else if (this.phase === 'vote') {
      if (active.every((p) => r.votes[p.id]) || now >= r.t1 + VOTE_GRACE_MS) this.#reveal();
    } else if (this.phase === 'reveal') {
      // Odadaki herkes "Devam" demeden sıradaki şarkıya geçilmez (kopanlar beklenmez).
      if (active.every((p) => r.cont.includes(p.id))) this.#advance();
    }
    if (this.ev && now > this.ev.until) {
      this.ev = null;
      this.dirty = true;
    }
    if (this.dirty || now - this.lastCast > HEARTBEAT_MS) this.#cast(now);
  }

  #cast(now) {
    this.dirty = false;
    this.lastCast = now;
    this.v++;
    const st = this.snapshot();
    this.send(st);
    this.onState(st);
  }

  snapshot() {
    const r = this.round;
    const st = {
      t: 'st',
      inst: this.inst,
      since: this.since,
      v: this.v,
      now: Date.now(),
      code: this.code,
      phase: this.phase,
      host: this.meId,
      max: this.max,
      set: this.set,
      pl: [...this.players.values()].map((p) => {
        const lib = this.libs.get(p.id);
        return { id: p.id, name: p.name, hue: p.hue, sc: p.sc, on: p.on ? 1 : 0, n: p.n, mode: p.mode, ok: !p.lt || (lib?.ready && lib.rev === p.lr) ? 1 : 0 };
      }),
    };
    if (this.phase === 'countdown') st.cd = this.cd;
    if (r && (this.phase === 'vote' || this.phase === 'reveal')) {
      st.rd = { n: r.n, no: r.no, id: r.id, meta: r.meta, pos: r.pos, t0: r.t0, t1: r.t1, voted: Object.keys(r.votes) };
      if (this.phase === 'reveal') Object.assign(st.rd, { ls: r.ls, vt: r.votes, dl: r.dl, cont: r.cont });
    }
    if (this.phase === 'won') st.win = this.win;
    if (this.ev) st.ev = { id: this.ev.id, k: this.ev.k, who: this.ev.who };
    return st;
  }

  // ---- sayfa yenilenirse kaldığı yerden ----

  serialize() {
    return {
      code: this.code,
      phase: this.phase,
      set: this.set,
      players: [...this.players.values()],
      libs: [...this.libs].filter(([, lib]) => lib.ready).map(([id, lib]) => [id, { rev: lib.rev, chunks: lib.chunks }]),
      kicked: [...this.kicked],
      round: this.round,
      used: [...this.used],
      rot: this.rot,
      rotI: this.rotI,
      rn: this.rn,
      no: this.no,
      win: this.win,
      cd: this.cd,
    };
  }

  #restore(s) {
    if (s.code !== this.code) return;
    const now = Date.now();
    this.phase = s.phase;
    this.set = { ...DEFAULT_SETTINGS, ...s.set };
    for (const p of s.players || []) this.players.set(p.id, { ...p, last: now });
    for (const [id, lib] of s.libs || []) {
      this.libs.set(id, { rev: lib.rev, total: lib.chunks.length, chunks: lib.chunks, got: lib.chunks.length, ready: true, ...buildLib(lib.chunks) });
    }
    this.kicked = new Set(s.kicked || []);
    this.round = s.round || null;
    this.used = new Set(s.used || []);
    this.rot = (s.rot || []).filter((id) => this.players.has(id));
    this.rotI = s.rotI || 0;
    this.rn = s.rn || 0;
    this.no = s.no || 0;
    this.win = s.win || null;
    this.cd = s.cd || 0;
    if ((this.phase === 'vote' || this.phase === 'reveal') && !this.round) this.phase = 'lobby';
  }
}
