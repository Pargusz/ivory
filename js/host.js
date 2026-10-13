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
const REACT_MS = 3500;
const REACT_GAP_MS = 350;
const SHARED_BIAS = 0.35;
const GUESS_MS = 90000;
const TURN_MS = 30000; // takım oyununda kesit bittikten sonra tahmin için tanınan süre
const META_WAIT_MS = 6000;
const FIRST_BONUS = 1;
const BET_MS = 10000; // düelloda seyircilerin bahis süresi
const READY_MS = 3500; // seyirci yoksa düello öncesi kısa bekleme
const DUEL_MS = 30000;
const DUEL_WIN = 3; // düelloyu kazanan
const BET_WIN = 2; // kazanana oynayan seyirci
const SOLO_SCAN = 400; // tek dinleyicili şarkı ararken oyuncu başına bakılan en çok şarkı
const RIGHT = 3;
const WRONG = -1;

export const REACTIONS = ['😂', '🔥', '😍', '😱', '🤨', '💀'];
export const WIN_OPTIONS = [15, 30, 50, 75];
export const TIME_OPTIONS = [15, 30, 45, 60];
// "Şarkıyı bil" modu: şarkının başı 5, 10, 20 saniye dinlenir; ne kadar erken bilinirse o kadar puan.
export const GUESS_STEPS = [5, 10, 20];
export const GUESS_PTS = [5, 3, 2];
// Düello: yalnızca bir kişinin dinlediği bir şarkı çalar; karşı karşıya gelen iki oyuncudan
// o kişiyi ilk bilen kazanır. Diğerleri bahis oynar; kaybedene oynanan her para kazananın olur.
// Az bahis alan taraf kazanırsa ödüller iki katıdır.
export const JAM_MS = 2500; // yanlış tahminden sonra silahın tutukluk süresi
export const DUEL_WIN_OPTIONS = [15, 30, 50, 75, 100];
// mode: who = kim dinliyor, name = şarkıyı bil, duel = düello. team (yalnızca name modunda): herkes tek takımdır,
// sırayla tahmin eder; bilemeyen sırayı bir sonrakine, şarkıyı bir sonraki aşamaya geçirir.
export const DEFAULT_SETTINGS = { src: FL | PL | AL, win: 30, time: 30, mid: true, ex: true, mode: 'who', team: false };

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
  constructor({ code, me, chunks, rev, send, resolveMeta, onState, onConflict, onAsk, maxPlayers, minPlayers, saved }) {
    this.code = code;
    this.meId = me.id;
    this.send = send;
    this.resolveMeta = resolveMeta;
    this.onState = onState;
    this.onConflict = onConflict;
    this.onAsk = onAsk;
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
    this.ts = 0; // takım puanı
    this.duels = new Map(); // oyuncu ve eşleşme başına düello sayısı
    this.skips = 0;
    this.cd = 0;
    this.ev = null;
    this.rx = []; // ekranda uçuşan tepkiler
    this.rxAt = new Map();
    this.know = {}; // know[oy veren][hedef] = [doğru, yanlış]: oyun sonu özeti için
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
    if (m.t === 'ask') {
      // Henüz odada olmayan biri Spotify e-postasını host'a iletiyor.
      this.onAsk?.({ name: cleanName(m.name) || 'Oyuncu', mail: String(m.mail || '').trim().slice(0, 120) });
      return;
    }
    const p = this.players.get(m.f);
    if (!p) return;
    if (m.f !== this.meId) this.#seen(p);
    if (m.t === 'lib') this.#lib(m);
    else if (m.t === 'v') this.#vote(p, m);
    else if (m.t === 'c') this.#cont(p, m);
    else if (m.t === 'sv') this.#saved(p);
    else if (m.t === 'rx') this.#react(p, m);
    else if (m.t === 'g') this.#guess(p, m);
    else if (m.t === 'b') this.#bet(p, m);
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
    if (this.know[old]) {
      this.know[newId] = this.know[old];
      delete this.know[old];
    }
    for (const row of Object.values(this.know)) {
      if (!row[old]) continue;
      row[newId] = row[old];
      delete row[old];
    }
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
      if (r.res && old in r.res) {
        r.res[newId] = r.res[old];
        delete r.res[old];
      }
      if (r.first === old) r.first = newId;
      if (r.order) r.order = swap(r.order);
      if (r.duel) {
        r.duel = swap(r.duel);
        for (const map of [r.bets, r.miss, r.jam]) {
          if (!(old in map)) continue;
          map[newId] = map[old];
          delete map[old];
        }
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

  // m.ok: bildi mi; m.s: kaçıncı aşamada (0 = 5 sn). Doğruluğu oyuncunun sayfası denetler.
  #guess(p, m) {
    const r = this.round;
    if (this.phase === 'duel' && r && m.r === r.n) {
      // Düello: şarkıyı kimin dinlediğini ilk bilen kazanır. Doğruluğu host denetler; yanlış
      // tahmin silahı bir süre tutuklar ve herkese gösterilir.
      const side = r.duel.indexOf(p.id);
      const now = Date.now();
      if (side < 0 || now < (r.jam[p.id] || 0) || !this.players.has(m.w)) return;
      if (r.ls.includes(m.w)) {
        r.win = side;
        this.#revealDuel();
      } else {
        r.miss[p.id] = (r.miss[p.id] || 0) + 1;
        r.jam[p.id] = now + JAM_MS - 300;
        this.dirty = true;
      }
      return;
    }
    if (this.phase !== 'guess' || !r || m.r !== r.n) return;
    if (r.order) {
      // Takım oyunu: yalnızca sırası gelen, o aşama için tek tahmin yapar.
      if (p.id === r.order[r.at] && (m.s | 0) === r.stage) this.#turn(p, !!m.ok);
      return;
    }
    if (r.res[p.id]) return;
    const ok = !!m.ok;
    r.res[p.id] = [ok ? 1 : 0, Math.max(0, Math.min(GUESS_STEPS.length - 1, m.s | 0))];
    if (ok && !r.first) r.first = p.id;
    this.dirty = true;
  }

  // Seyircinin bahsi: süre dolana kadar değiştirilebilir. Düellocular bahis oynayamaz.
  #bet(p, m) {
    const r = this.round;
    if (this.phase !== 'bet' || !r || m.r !== r.n || r.duel.includes(p.id)) return;
    if (m.k !== 0 && m.k !== 1) return;
    if (r.bets[p.id] === m.k) return;
    r.bets[p.id] = m.k;
    this.dirty = true;
  }

  // Sıradaki iki düellocu: en az düello yapanlar, kendi aralarında en az karşılaşmış olanlar.
  // Böylece herkes eşit sıklıkta çıkar ve eşleşmeler sürekli değişir.
  #pair() {
    const on = shuffle(this.rot.filter((id) => this.players.get(id)?.on));
    if (on.length < 2) return null;
    const count = (id) => this.duels.get(id) || 0;
    const key = (x, y) => (x < y ? x + '|' + y : y + '|' + x);
    const met = (x, y) => this.duels.get(key(x, y)) || 0;
    const a = on.slice().sort((x, y) => count(x) - count(y))[0];
    const b = on.filter((id) => id !== a).sort((x, y) => count(x) - count(y) || met(a, x) - met(a, y))[0];
    for (const id of [a, b, key(a, b)]) this.duels.set(id, (this.duels.get(id) || 0) + 1);
    return Math.random() < 0.5 ? [a, b] : [b, a];
  }

  #revealDuel() {
    const r = this.round;
    r.dl = {};
    if (r.win >= 0) {
      const winner = this.players.get(r.duel[r.win]);
      const bettors = Object.entries(r.bets).filter(([id]) => this.players.has(id));
      const lost = bettors.filter(([, k]) => k !== r.win).length;
      // Az bahis alan taraf kazandıysa (azınlık) ödüller iki katı: geride kalana dönüş şansı.
      r.x2 = bettors.length - lost < lost;
      const mult = r.x2 ? 2 : 1;
      // Kaybedene oynanan paralar kazananın olur.
      if (winner) r.dl[winner.id] = DUEL_WIN + lost * mult;
      for (const [id, k] of bettors) if (k === r.win) r.dl[id] = BET_WIN * mult;
      for (const [id, delta] of Object.entries(r.dl)) this.players.get(id).sc += delta;
    }
    this.phase = 'reveal';
    this.dirty = true;
    if (!this.#leaders().reached) this.#prepare();
  }

  // Sırası gelen bildiyse tur biter; bilemediyse (yanlış, pas ya da süre) şarkı bir sonraki
  // aşamaya, sıra bir sonraki oyuncuya geçer. Son aşamada da bilinemezse tur kaybedilir.
  #turn(p, ok) {
    const r = this.round;
    if (ok) {
      r.res[p.id] = [1, r.stage];
      r.first = p.id;
      this.#revealGuess();
      return;
    }
    if (r.stage >= GUESS_STEPS.length - 1) {
      this.#revealGuess();
      return;
    }
    r.stage++;
    r.at = (r.at + 1) % r.order.length;
    r.gt1 = Date.now() + GUESS_STEPS[r.stage] * 1000 + TURN_MS;
    this.dirty = true;
  }

  #teams() {
    return this.set.mode === 'name' && this.set.team;
  }

  #react(p, m) {
    const now = Date.now();
    if (this.phase !== 'reveal' && this.phase !== 'won') return;
    if (!Number.isInteger(m.e) || m.e < 0 || m.e >= REACTIONS.length) return;
    if (now - (this.rxAt.get(p.id) || 0) < REACT_GAP_MS) return;
    this.rxAt.set(p.id, now);
    this.rx.push({ id: uid(5), p: p.id, e: m.e, until: now + REACT_MS });
    if (this.rx.length > 16) this.rx.shift();
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
      if (this.set.mode === 'duel') {
        // Düelloda yalnızca bir kişinin dinlediği şarkı aranır; yoksa en az dinleyenli olan alınır.
        const sample = shuffle([...buckets.values()].flat()).slice(0, SOLO_SCAN);
        let fewest = Infinity;
        for (const e of sample) {
          const n = this.#listeners(e).length;
          if (n && n < fewest) {
            fewest = n;
            chosen = e;
            if (n === 1) break;
          }
        }
      } else if (Math.random() < SHARED_BIAS) {
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
    const next = (this.next = { id: e.id, keys: e.keys, dur: e.dur, meta: null, at: Date.now(), settled: false });
    Promise.resolve(this.resolveMeta(e.id))
      .finally(() => {
        next.settled = true;
      })
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
    const name = this.set.mode === 'name';
    // Şarkıyı bil modunda başlık şart: gelene kadar beklenir, bulunamazsa başka şarkı seçilir.
    if (t && name && !t.meta?.name && this.skips < 12) {
      if (t.settled || Date.now() - t.at > META_WAIT_MS) {
        this.skips++;
        this.next = null;
        this.#prepare();
      }
      return;
    }
    // Düelloda şarkıyı dinleyen biri kalmadıysa (sahibi odadan çıktıysa) başka şarkı seçilir.
    if (t && this.set.mode === 'duel' && !this.#listeners(t).length && this.skips < 12) {
      this.skips++;
      this.next = null;
      this.#prepare();
      return;
    }
    this.next = null;
    if (!t || (name && !t.meta?.name)) {
      this.#finish(true);
      return;
    }
    this.skips = 0;
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
    if (this.set.mode === 'duel') {
      const duel = this.#pair();
      if (!duel) {
        this.round = null;
        this.#finish(true);
        return;
      }
      const watchers = [...this.players.values()].some((p) => p.on && !duel.includes(p.id));
      Object.assign(this.round, { duel, bets: {}, miss: {}, jam: {}, win: null, x2: false, bt1: t0 + (watchers ? BET_MS : READY_MS) });
      this.phase = 'bet';
      this.dirty = true;
      return;
    }
    if (name) {
      Object.assign(this.round, { t1: t0 + GUESS_MS, res: {}, first: null });
      if (this.#teams()) {
        // Her şarkıda ilk tahmin sırası bir sonraki oyuncuya kayar.
        const on = this.rot.filter((id) => this.players.get(id)?.on);
        const from = on.length ? (this.no - 1) % on.length : 0;
        Object.assign(this.round, { order: on.slice(from).concat(on.slice(0, from)), at: 0, stage: 0, gt1: t0 + GUESS_STEPS[0] * 1000 + TURN_MS });
      }
      this.phase = 'guess';
      this.dirty = true;
      return;
    }
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
      for (const id of ballot) {
        const hit = listeners.has(id);
        delta += hit ? RIGHT : WRONG;
        if (id === p.id) continue;
        const row = (this.know[p.id] ||= {});
        (row[id] ||= [0, 0])[hit ? 0 : 1]++;
      }
      r.dl[p.id] = delta;
      p.sc += delta;
    }
    this.phase = 'reveal';
    this.dirty = true;
    if (!this.#leaders().reached) this.#prepare();
  }

  #revealGuess() {
    const r = this.round;
    const teams = this.#teams();
    let total = 0;
    r.dl = {};
    for (const p of this.players.values()) {
      const res = r.res[p.id];
      if (!res) continue;
      let delta = res[0] ? GUESS_PTS[res[1]] : 0;
      // Bireysel oyunda şarkıyı ilk bilen ek puan alır.
      if (!teams && r.first === p.id) delta += FIRST_BONUS;
      r.dl[p.id] = delta;
      p.sc += delta;
      total += delta;
    }
    // Takım oyununda puan ortak kasaya da yazılır; oyuncunun kendi puanı katkısını gösterir.
    if (teams) {
      r.td = total;
      this.ts += total;
    }
    this.phase = 'reveal';
    this.dirty = true;
    if (!this.#leaders().reached) this.#prepare();
  }

  #leaders() {
    if (this.#teams()) {
      return { top: this.ts, reached: this.ts >= this.set.win, ids: [...this.players.keys()] };
    }
    let top = -Infinity;
    for (const p of this.players.values()) top = Math.max(top, p.sc);
    return { top, reached: top >= this.set.win, ids: [...this.players.values()].filter((p) => p.sc === top).map((p) => p.id) };
  }

  #advance() {
    if (this.#leaders().reached) this.#finish(false);
    else this.#startRound();
  }

  #finish(outOfSongs) {
    const lead = this.#leaders();
    this.win = { ids: lead.ids, out: !!outOfSongs, sum: this.#summary() };
    if (this.#teams()) this.win.team = { pts: this.ts, songs: this.no };
    this.phase = 'won';
    this.next = null;
    this.dirty = true;
  }

  // Oyun sonu özeti, oyuncu başına: tw = müzik ikizi [kim, ortak şarkı, kendi şarkılarının yüzdesi],
  // kn = onu en iyi tanıyan [kim, doğru tahmin].
  #summary() {
    const sets = new Map();
    for (const id of this.players.keys()) {
      const lib = this.libs.get(id);
      if (!lib?.ready || !lib.map.size) continue;
      const set = new Set();
      for (const e of lib.map.values()) set.add(e.keys[0] || e.id);
      sets.set(id, set);
    }
    const sum = {};
    for (const id of this.players.keys()) {
      const s = {};
      const mine = sets.get(id);
      let best = 0;
      for (const [other, theirs] of mine ? sets : []) {
        if (other === id) continue;
        const [small, big] = mine.size < theirs.size ? [mine, theirs] : [theirs, mine];
        let n = 0;
        for (const k of small) if (big.has(k)) n++;
        // İki kütüphanenin büyüklüğü çok farklıysa da adil olsun diye birleşime oranlanır.
        const score = n / (mine.size + theirs.size - n);
        if (n && score > best) {
          best = score;
          s.tw = [other, n, Math.max(1, Math.round((n * 100) / mine.size))];
        }
      }
      let top = null;
      for (const [voter, row] of Object.entries(this.know)) {
        const a = row[id];
        if (!a || !a[0] || !this.players.has(voter)) continue;
        const score = a[0] - a[1];
        if (!top || score > top.score || (score === top.score && a[0] > top.right)) top = { voter, score, right: a[0] };
      }
      if (top) s.kn = [top.voter, top.right];
      if (s.tw || s.kn) sum[id] = s;
    }
    return sum;
  }

  // ---- host'un yaptıkları ----

  setSettings(patch) {
    if (this.phase !== 'lobby') return;
    const s = { ...this.set, ...patch };
    s.src &= FL | PL | AL;
    if (!s.src) return;
    s.mode = ['who', 'name', 'duel'].includes(s.mode) ? s.mode : 'who';
    // 100 puan yalnızca düelloda var; başka moda geçilince en yakın seçeneğe iner.
    if (s.mode !== 'duel' && s.win > 75) s.win = 75;
    if (!(s.mode === 'duel' ? DUEL_WIN_OPTIONS : WIN_OPTIONS).includes(s.win) || !TIME_OPTIONS.includes(s.time)) return;
    s.mid = !!s.mid;
    s.ex = !!s.ex;
    s.team = !!s.team;
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
    if (this.set.mode === 'duel' && [...this.players.values()].filter((p) => p.on).length < 2) return { ok: false, why: 'Düello için en az 2 oyuncu gerekli' };
    if (!this.songCount()) return { ok: false, why: 'Seçili kaynaklarda hiç şarkı yok' };
    return { ok: true };
  }

  start() {
    if ((this.phase !== 'lobby' && this.phase !== 'won') || !this.canStart().ok) return false;
    for (const p of this.players.values()) p.sc = 0;
    this.used.clear();
    this.know = {};
    this.ts = 0;
    this.duels = new Map();
    this.skips = 0;
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
    } else if (this.phase === 'bet') {
      const watchers = active.filter((p) => !r.duel.includes(p.id));
      // Herkes bahsini koyduysa süre beklenmez; yine de son bir nefeslik pay kalır.
      if (watchers.length && watchers.every((p) => r.bets[p.id] != null)) r.bt1 = Math.min(r.bt1, now + 2000);
      if (now >= r.bt1) {
        r.t0 = now + 300;
        r.t1 = r.t0 + DUEL_MS;
        this.phase = 'duel';
        this.dirty = true;
      }
    } else if (this.phase === 'duel') {
      // Süre dolarsa ya da düelloculardan biri koparsa berabere biter.
      if (now >= r.t1 + VOTE_GRACE_MS || r.duel.some((id) => !this.players.get(id)?.on)) {
        r.win = -1;
        this.#revealDuel();
      }
    } else if (this.phase === 'guess' && r.order) {
      // Sırası gelen koptuysa sıra aşama harcamadan geçer; süresi dolduysa bilemedi sayılır.
      if (!this.players.get(r.order[r.at])?.on) {
        r.order.splice(r.at, 1);
        if (!r.order.length) this.#revealGuess();
        else {
          r.at %= r.order.length;
          r.gt1 = now + GUESS_STEPS[r.stage] * 1000 + TURN_MS;
          this.dirty = true;
        }
      } else if (now >= r.gt1 + VOTE_GRACE_MS) this.#turn(null, false);
    } else if (this.phase === 'guess') {
      if (active.every((p) => r.res[p.id]) || now >= r.t1 + VOTE_GRACE_MS) this.#revealGuess();
    } else if (this.phase === 'reveal') {
      // Odadaki herkes "Devam" demeden sıradaki şarkıya geçilmez (kopanlar beklenmez).
      if (active.every((p) => r.cont.includes(p.id))) this.#advance();
    }
    if (this.rx.length && now > this.rx[0].until) this.rx = this.rx.filter((x) => now <= x.until);
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
    if (this.#teams()) st.ts = this.ts;
    if (r && ['vote', 'guess', 'bet', 'duel', 'reveal'].includes(this.phase)) {
      st.rd = { n: r.n, no: r.no, id: r.id, meta: r.meta, pos: r.pos, t0: r.t0, t1: r.t1, voted: Object.keys(r.votes) };
      if (r.res) st.rd.done = Object.keys(r.res);
      if (r.order && this.phase === 'guess') Object.assign(st.rd, { turn: r.order[r.at], gs: r.stage, t1: r.gt1 });
      if (this.phase === 'reveal') Object.assign(st.rd, { ls: r.ls, vt: r.votes, dl: r.dl, cont: r.cont });
      if (this.phase === 'reveal' && r.res) Object.assign(st.rd, { res: r.res, first: r.first, td: r.td });
      if (r.duel) Object.assign(st.rd, { duel: r.duel, bets: r.bets, miss: r.miss, bt1: r.bt1 });
      if (r.duel && this.phase === 'reveal') Object.assign(st.rd, { win: r.win, x2: r.x2 });
    }
    if (this.phase === 'won') st.win = this.win;
    if (this.ev) st.ev = { id: this.ev.id, k: this.ev.k, who: this.ev.who };
    if (this.rx.length) st.rx = this.rx.map((x) => [x.id, x.p, x.e]);
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
      know: this.know,
      ts: this.ts,
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
    this.know = s.know || {};
    this.ts = Number(s.ts) || 0;
    if (['vote', 'guess', 'bet', 'duel', 'reveal'].includes(this.phase) && !this.round) this.phase = 'lobby';
  }
}
