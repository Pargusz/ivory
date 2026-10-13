// Arayüz: ekranlar, etkileşimler ve oturumun (host ya da oyuncu) bağlanması.

import { $, esc, uid, makeCode, cleanCode, cleanName, ls, ss, onTick, copyText, cyrb53, titleMatch, artistMatch, squash, sleep, skipSong, CODE_LEN } from './util.js';
import * as spotify from './spotify.js';
import { Channel } from './net.js';
import { HostGame, WIN_OPTIONS, TIME_OPTIONS, REACTIONS, GUESS_STEPS, GUESS_PTS, JAM_MS, DUEL_WIN_OPTIONS, COVER_STEP } from './host.js';
import { ClientSession } from './client.js';
import { Playback } from './audio.js';
import { FL, PL, AL, SOURCES, encodeLib } from './lib.js';
import { demoLibrary, demoMeta, demoCover, isDemo } from './demo.js';
import { lyrics, hintLines, startAt } from './lyrics.js';

const CFG = {
  spotifyClientIds: [],
  maxPlayers: 24,
  playlistName: 'Ivory',
  brokers: ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081/'],
  ...(window.IVORY_CONFIG || {}),
};

// Spotify yönlendirme adresi olarak "localhost" kabul etmiyor; yerelde 127.0.0.1 kullan.
if (location.hostname === 'localhost') location.replace(location.href.replace('//localhost', '//127.0.0.1'));

const LOCAL = ['127.0.0.1', '[::1]', 'localhost'].includes(location.hostname);
// Yerelde tek başına deneyebilmek için 1; yayındaki sitede config.js'teki değer (varsayılan 2).
const MIN_PLAYERS = LOCAL ? 1 : Math.max(1, CFG.minPlayers || 2);
// Yalnızca yerelde, adrese ?demo eklenince açılan test kaynağı; oyuncular görmez.
const DEMO = LOCAL && new URLSearchParams(location.search).has('demo');
const JOIN_PATIENCE_MS = 10000;
const MAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GONE = {
  kick: 'Host seni odadan çıkardı',
  full: 'Oda dolu',
  closed: 'Host odayı kapattı',
};

// Client ID yalnızca config.js'ten gelir; oyunculara hiçbir zaman sorulmaz.
spotify.init(CFG.spotifyClientIds, CFG.playlistName);

// Kullanıcı adı sekmeye özeldir: davet linkiyle gelen herkese sorulur, yenilemede kalır.
const me = { id: ss.get('pid') || uid(8), name: ss.get('name', ''), mode: 'none' };
ss.set('pid', me.id);

const app = {
  view: 'home',
  intent: null,
  code: '',
  source: DEMO ? 'demo' : 'spotify',
  spot: null, // Spotify'dan okunan kütüphane
  busy: null,
  libErr: null,
  autoGo: false,
  lib: null, // odaya götürülen kütüphane
  s: null, // oturum: { host, code, chan, core, stop }
  st: null, // odanın son durumu
  ballot: new Set(),
  g: { stage: 0, done: null, text: '' }, // "şarkıyı bil" turundaki kendi durumum
  lyr: null, // bu turun şarkı sözleri
  round: 0,
  voteSent: 0,
  contSent: 0,
  savedRound: 0,
  saving: false,
  playedRound: 0,
  modal: null,
  devices: null,
  devBusy: false,
  devPicked: false, // oyuncu çalma yerini kendi seçti mi
  mail: '', // izin isteyen oyuncunun yazdığı Spotify e-postası
  mailSent: false,
  asks: ss.get('asks', []), // host'a gelen giriş istekleri: [{ name, mail }]
  toasts: [],
  seenEv: null,
  joinAt: 0,
};

const meta = new Map(); // kendi şarkılarımın başlık/kapak bilgisi
let wakeLock = null;

const playback = new Playback({ notify: (text) => toast(text), onChange: () => update() });

// ---------- küçük yardımcılar ----------

const ICONS = {
  copy: '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  sound: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6"/><path d="M18 6.5a7.8 7.8 0 0 1 0 11"/>',
  mute: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="m16 9.5 5 5m0-5-5 5"/>',
  exit: '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="M10 16l-4-4 4-4"/><path d="M6 12h9"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  crown: '<path d="m4 8 4 4 4-6 4 6 4-4-1.5 10h-13z"/>',
  ear: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/>',
  back: '<path d="m14 6-6 6 6 6"/>',
  share: '<path d="M12 15V4m0 0L8 8m4-4 4 4"/><path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>',
  play: '<path d="M8 5.5v13l11-6.5z"/>',
};
const icon = (name) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

const initial = (name) => ([...String(name || '?')][0] || '?').toLocaleUpperCase('tr');
const av = (p, cls = '') => `<span class="av ${cls}" style="--h:${p.hue}">${esc(initial(p.name))}</span>`;
const signed = (n) => (n > 0 ? '+' + n : n < 0 ? '−' + Math.abs(n) : '0');
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const teamsOn = (st) => st.set.mode === 'name' && st.set.team;
const hnow = () => Date.now() + (app.s && !app.s.host ? app.s.core.off : 0);
const isHost = () => !!app.s?.host;
const safeImg = (url) => (/^https:\/\/[^\s"'<>]+$/.test(url || '') ? url : '');

function toast(text, kind = '') {
  if (!text) return;
  app.toasts.push({ id: uid(4), text, kind, until: Date.now() + 4200 });
  if (app.toasts.length > 4) app.toasts.shift();
  update();
}

function setName(raw) {
  me.name = cleanName(raw);
  ss.set('name', me.name);
}

function inviteLink(code) {
  return location.origin + location.pathname + '#' + code;
}

// ---------- kütüphane ----------

function setLib(mode, tracks, extra = {}) {
  meta.clear();
  for (const t of tracks) if (t.name) meta.set(t.id, { name: t.name, artists: t.artists, img: t.img, dur: t.dur });
  app.lib = { mode, tracks, chunks: encodeLib(tracks), rev: uid(5), count: tracks.length, ...extra };
  me.mode = mode;
  ss.set('lib', { mode, tracks });
}

async function loadSpotify() {
  if (app.busy) return;
  app.busy = { label: 'Spotify', count: 0 };
  app.libErr = null;
  update();
  try {
    const res = await spotify.loadLibrary((p) => {
      app.busy = p;
      update();
    });
    app.spot = res;
    ss.del('tried');
    refreshDevices(true);
  } catch (e) {
    app.spot = null;
    app.autoGo = false;
    if (e.status === 403) {
      if (tryNextGroup()) return; // sıradaki Spotify uygulamasına yönleniyor
      app.libErr = { kind: 'unreg' };
    } else if (e.status === 401) app.libErr = { kind: 'auth' };
    else app.libErr = { kind: 'other', text: e.message };
  }
  app.busy = null;
  update();
  if (app.autoGo && app.spot && app.view === 'prep') go();
}

// Birden fazla Spotify uygulaması (Client ID) varsa oyuncunun hangisine eklendiğini
// kendimiz buluruz: biri kabul etmezse sıradakiyle bağlanmayı deneriz.
function tryNextGroup() {
  const tried = new Set(ss.get('tried', []));
  tried.add(spotify.group());
  const next = Array.from({ length: spotify.groupCount() }, (_, i) => i).find((i) => !tried.has(i));
  if (next == null) {
    ss.del('tried');
    return false;
  }
  ss.set('tried', [...tried]);
  spotify.logout();
  spotify.login(next, { intent: app.intent, name: me.name });
  return true;
}

// İzin isteyen oyuncunun e-postasını odadaki host'a iletir (odaya girmeden, yalnızca bu mesaj için bağlanır).
function askHost(code, mail) {
  const chan = new Channel({ code, id: me.id, host: false, brokers: CFG.brokers });
  const msg = { t: 'ask', name: cleanName(me.name) || 'Oyuncu', mail };
  let ticks = 0;
  let sent = 0;
  const stop = onTick(() => {
    if (!chan.online || ticks++ % 4) return;
    chan.send(msg);
    if (++sent >= 4) done();
  });
  const done = () => {
    stop();
    setTimeout(() => chan.close(), 600);
  };
  setTimeout(done, 15000);
  chan.open();
}

function saveAsks() {
  ss.set('asks', app.asks);
  update();
}

// Host için: şarkının başlık bilgisi. "Şarkıyı bil" modunda kesitin başlayacağı yer de (at)
// eklenir: başı sessiz şarkılar sözlerin başladığı yerden çalar.
async function resolveMeta(id) {
  let m = await trackMeta(id);
  const mode = app.st?.set.mode;
  // Kapak bulmacasında albümün adı da doğru cevap sayılır; kendi kütüphanemdeki şarkılarda
  // albüm adı tutulmadığı için Spotify'dan tamamlanır.
  if (m && !m.skip && mode === 'cover' && !m.album && !isDemo(id) && spotify.authed()) {
    const full = await spotify.track(id).catch(() => null);
    if (full) m = { ...m, album: full.album, img: m.img || full.img };
  }
  if (!m || m.skip || mode !== 'name') return m;
  const lines = await Promise.race([lyrics(id, m), sleep(3500).then(() => null)]);
  return { ...m, at: startAt(lines, m.dur) };
}

async function trackMeta(id) {
  if (isDemo(id)) return demoMeta(id);
  if (meta.has(id)) return meta.get(id);
  let m = null;
  if (spotify.authed()) m = await spotify.track(id).catch(() => null);
  m ||= await spotify.publicMeta(id).catch(() => null);
  // skip: host bu şarkıyla tur açmaz (çalınamıyor ya da oyuna girmiyor).
  return m && (m.gone || skipSong(m.name, m.artists)) ? { ...m, skip: true } : m;
}

// ---------- oturum ----------

function openPrep(intent) {
  app.intent = intent;
  app.view = 'prep';
  app.libErr = null;
  if (app.source === 'spotify' && spotify.authed() && !app.spot) loadSpotify();
  update();
  focusName();
}

function focusName() {
  requestAnimationFrame(() => {
    if (app.view === 'prep' && cleanName(me.name).length < 2) $('[data-model="name"]')?.focus();
  });
}

function go() {
  const name = cleanName(me.name);
  if (name.length < 2) {
    focusName();
    return toast('Önce kullanıcı adını yaz (en az 2 harf)');
  }
  setName(name);
  if (app.source === 'demo' && DEMO) {
    setLib('demo', demoLibrary());
  } else {
    if (!spotify.configured()) return toast('Spotify bağlantısı bu sitede henüz ayarlanmadı');
    if (!spotify.authed()) return spotify.login(spotify.group(), { intent: app.intent, name });
    if (!app.spot) {
      app.autoGo = true;
      return loadSpotify();
    }
    setLib('spotify', app.spot.tracks);
  }
  app.autoGo = false;
  if (app.intent.kind === 'create') startHost(makeCode());
  else startClient(app.intent.code);
}

function enterRoom(session) {
  app.s = session;
  app.st = null;
  app.view = 'room';
  app.joinAt = Date.now();
  // Önceki odadan kalan "oy verdim / devam dedim" işaretleri yeni odada aynı numaralı turu kilitlemesin.
  resetRound(0);
  app.voteSent = app.contSent = app.savedRound = app.playedRound = 0;
  app.seenEv = null;
  playback.prepare();
  ss.set('room', { code: session.code, host: session.host });
  history.replaceState(null, '', '#' + session.code);
  session.chan.open().then(update);
  update();
}

function startHost(code, saved) {
  let core;
  const chan = new Channel({
    code,
    id: me.id,
    host: true,
    brokers: CFG.brokers,
    onMessage: (m) => core.handle(m),
    onChange: () => {
      if (chan.online) playback.revive();
      update();
    },
  });
  core = new HostGame({
    code,
    me: { id: me.id, name: me.name, mode: me.mode, count: app.lib.count },
    chunks: app.lib.chunks,
    rev: app.lib.rev,
    send: (m) => chan.send(m),
    resolveMeta,
    onState: applyState,
    onConflict: () => endSession('Bu oda başka bir sekmede açıldı'),
    onAsk: (ask) => {
      if (!MAIL.test(ask.mail) || app.asks.some((a) => a.mail === ask.mail)) return;
      app.asks.push(ask);
      if (app.asks.length > 12) app.asks.shift();
      toast(`${ask.name} giriş izni istiyor`);
      saveAsks();
    },
    maxPlayers: CFG.maxPlayers,
    minPlayers: MIN_PLAYERS,
    saved,
  });
  let savedAt = 0;
  const stop = onTick((now) => {
    core.tick(now);
    if (now - savedAt > 2000) {
      savedAt = now;
      ss.set('host', core.serialize());
    }
  });
  enterRoom({ host: true, code, chan, core, stop });
}

function startClient(code) {
  let core;
  const chan = new Channel({
    code,
    id: me.id,
    host: false,
    brokers: CFG.brokers,
    onMessage: (m) => core.receive(m),
    onChange: () => {
      core.poke();
      if (chan.online) playback.revive();
      update();
    },
  });
  core = new ClientSession({
    me,
    chunks: app.lib.chunks,
    rev: app.lib.rev,
    count: app.lib.count,
    send: (m) => chan.send(m),
    onState: applyState,
    onGone: (why) => endSession(GONE[why] || 'Odadan çıkıldı'),
  });
  const stop = onTick((now) => core.tick(now));
  enterRoom({ host: false, code, chan, core, stop });
}

function endSession(message) {
  const s = app.s;
  if (s) {
    s.stop();
    setTimeout(() => s.chan.close(), 400);
  }
  playback.stop();
  app.s = null;
  app.st = null;
  app.modal = null;
  app.view = 'home';
  app.intent = null;
  ss.del('room');
  ss.del('host');
  ss.del('asks');
  app.asks = [];
  history.replaceState(null, '', location.pathname);
  releaseWake();
  if (message) toast(message);
  update();
}

function resetRound(n) {
  app.round = n;
  app.ballot = new Set();
  app.g = { stage: 0, done: null, text: '' };
  app.lyr = null;
}

// Host'tan (ya da kendi motorumuzdan) gelen her yeni durumda çalışır.
function applyState(st) {
  app.st = st;
  const rd = st.rd;
  if (rd && rid(st) !== app.round) resetRound(rid(st));
  // Tahmin aşamasında şarkının kesiti, diğerlerinde tamamı çalar.
  // Takım oyununda aşama herkes için ortaktır; aşama değişince yeni kesit çalar.
  // Düelloda bahis sırasında ses yoktur; düello başlayınca şarkı herkese çalar.
  // Kapak bulmacası tahmin sırasında sessizdir.
  const quiet = st.phase === 'guess' && st.set.mode === 'cover';
  const want = !rd || quiet ? 0 : st.phase === 'guess' ? `g${rd.n}:${rd.gs ?? ''}` : ['vote', 'duel', 'reveal'].includes(st.phase) ? rd.n : 0;
  // Host yanlış tahminimi bildirdi: silah tutukluk yapar.
  const missed = rd?.miss?.[me.id] || 0;
  if (rd?.duel && missed > (app.g.missed || 0)) {
    app.g.missed = missed;
    app.g.fired = null;
    app.g.jam = Date.now() + JAM_MS;
  }
  if (rd?.duel && st.phase === 'reveal' && rd.win >= 0 && app.shot !== rid(st)) {
    app.shot = rid(st);
    shotSound();
  }
  if (want !== app.playedRound) {
    app.playedRound = want;
    // Tahminini bitiren şarkının tamamını zaten dinliyordur; açıklamada baştan başlatma.
    const full = !!playback.cur && playback.cur.id === rd?.id && !playback.cur.limit;
    if (!want) playback.stop();
    else if (st.phase !== 'guess') full || playback.play({ id: rd.id, pos: rd.pos });
    else if (rd.done.includes(me.id)) playback.play({ id: rd.id, pos: rd.meta?.at || 0 });
    else {
      playSnippet();
      const id = rd.id;
      if (!app.lyr) lyrics(id, rd.meta).then((lines) => {
        if (app.st?.rd?.id !== id) return;
        app.lyr = lines;
        update();
      });
    }
  }
  if (st.ev && st.ev.id !== app.seenEv) {
    app.seenEv = st.ev.id;
    if (st.ev.k === 'sv') toast(`${st.ev.who} bu şarkıyı listesine ekledi`, 'good');
  }
  for (const [id, who, e] of st.rx || []) {
    if (seenRx.has(id)) continue;
    seenRx.add(id);
    if (seenRx.size > 200) seenRx.delete(seenRx.values().next().value);
    flyReaction(st.pl.find((p) => p.id === who), REACTIONS[e]);
  }
  if (st.phase !== 'lobby') keepAwake();
  if (st.phase === 'won') requestAnimationFrame(() => confetti());
  update();
}

const seenRx = new Set();

// Tepki, çizimden bağımsız olarak ekranın altından yukarı süzülür.
function flyReaction(p, emoji) {
  if (!emoji) return;
  const el = document.createElement('div');
  el.className = 'fly';
  el.style.left = 8 + Math.random() * 84 + '%';
  el.innerHTML = `<b>${emoji}</b>${p ? `<span style="--h:${p.hue}">${esc(p.name)}</span>` : ''}`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

const reactBar = () => `<div class="reacts" data-key="reacts">${REACTIONS.map((e, i) => `<button data-act="react" data-e="${i}" aria-label="Tepki ${e}">${e}</button>`).join('')}</div>`;

// Turun kimliği: tur numaraları her odada 1'den başladığı için oyunun kimliğiyle birlikte tutulur.
const rid = (st) => st.inst + ':' + st.rd.n;
const hasVoted = (st) => app.voteSent === rid(st) || st.rd.voted.includes(me.id);
const hasContinued = (st) => app.contSent === rid(st) || st.rd.cont.includes(me.id);

function sendToCore(msg) {
  if (isHost()) app.s.core.handle({ ...msg, f: me.id });
  else if (msg.t === 'g' && msg.w) app.s.core.pick(msg.r, msg.w);
  else if (msg.t === 'b') app.s.core.bet(msg.r, msg.k);
  else if (msg.t === 'v') app.s.core.vote(msg.r, msg.b);
  else if (msg.t === 'c') app.s.core.cont(msg.r);
  else if (msg.t === 'sv') app.s.core.saved();
  else if (msg.t === 'rx') app.s.core.react(msg.e);
  else if (msg.t === 'g') app.s.core.guess(msg.r, msg.ok, msg.s);
}

// Kapak bulmacasında aşama saate bağlıdır: 0 = bulanık, 1 = yarı net, 2 = net.
const coverStage = (st) => Math.max(0, Math.min(GUESS_STEPS.length - 1, Math.floor((hnow() - st.rd.t0) / (COVER_STEP * 1000))));
const COVER_LABELS = ['Bulanık', 'Yarı net', 'Net'];
const hasGuessed = (st) => !!app.g.done || st.rd.done.includes(me.id);
// Takım oyununda aşamayı host tutar (rd.gs), bireyselde herkes kendi aşamasındadır.
const coop = (st) => st.rd.turn !== undefined;
const stageOf = (st) => (coop(st) ? st.rd.gs : app.g.stage);

function playSnippet() {
  const st = app.st;
  if (st?.rd) playback.play({ id: st.rd.id, pos: st.rd.meta?.at || 0, limit: GUESS_STEPS[stageOf(st)] * 1000, secret: true });
}

// Tahmin kutusuna yazılanı içeren şarkılar: önce kendi kütüphanem, sonra Spotify araması.
let sugTimer = 0;
function suggest(text) {
  clearTimeout(sugTimer);
  const q = text.trim();
  const g = app.g;
  if (q.length < 2) {
    g.sug = [];
    return update();
  }
  const key = squash(q.toLowerCase());
  if (app.st?.set.mode === 'cover') return suggestArtists(q, key, g);
  const seen = new Set();
  const add = (list, t) => {
    const id = squash((t.name + '|' + String(t.artists || '').split(',')[0]).toLowerCase());
    if (seen.has(id) || list.length >= 7) return;
    seen.add(id);
    list.push({ name: t.name, artists: t.artists || '' });
  };
  const mine = [];
  for (const t of app.lib?.tracks || []) {
    if (mine.length >= 4) break;
    if (t.name && squash(t.name.toLowerCase()).includes(key) && !skipSong(t.name, t.artists)) add(mine, t);
  }
  g.sug = mine;
  update();
  if (!spotify.authed()) return;
  sugTimer = setTimeout(async () => {
    const found = await spotify.search(q).catch(() => []);
    if (app.g !== g || g.text.trim() !== q) return;
    const list = mine.slice();
    for (const t of found) add(list, t);
    g.sug = list;
    update();
  }, 250);
}

// Yazılan tahmin bu turun şarkısı mı? Listeden seçildiyse sanatçı da tutmalı: aynı adlı başka
// bir şarkı doğru sayılmaz.
function isRight(text, st) {
  const m = st.rd.meta || {};
  // Kapak bulmacası: sanatçılardan biri, albüm ya da şarkının adı doğru sayılır.
  if (st.set.mode === 'cover') {
    return [...String(m.artists || '').split(','), m.album, m.name].some((c) => c && c.trim() && titleMatch(text, c.trim(), ''));
  }
  const picked = app.g.pick?.name === text ? app.g.pick : null;
  return titleMatch(text, st.rd.meta?.name, st.rd.meta?.artists) && (!picked || artistMatch(picked.artists, st.rd.meta?.artists));
}

let shotCtx = null;

// Düelloda atılan kurşunun sesi: kısa, sönümlenen bir gürültü patlaması.
function shotSound() {
  if (playback.mode === 'none') return;
  try {
    const ctx = (shotCtx ||= new (window.AudioContext || window.webkitAudioContext)());
    ctx.resume?.();
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.35), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 3;
    const src = ctx.createBufferSource();
    const low = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    src.buffer = buf;
    low.type = 'lowpass';
    low.frequency.value = 2400;
    gain.gain.value = 0.5 * Math.max(0.15, playback.volume);
    src.connect(low).connect(gain).connect(ctx.destination);
    src.start();
  } catch {}
}

// Kapak bulmacasının öneri listesi: sanatçı adları (kendi kütüphanem, sonra Spotify araması).
function suggestArtists(q, key, g) {
  const seen = new Set();
  const add = (list, name) => {
    const id = squash(String(name || '').toLowerCase());
    if (!id || seen.has(id) || list.length >= 7) return;
    seen.add(id);
    list.push({ name: name.trim(), artists: '' });
  };
  const mine = [];
  for (const t of app.lib?.tracks || []) {
    if (mine.length >= 4) break;
    for (const a of String(t.artists || '').split(',')) if (squash(a.toLowerCase()).includes(key)) add(mine, a);
  }
  g.sug = mine;
  update();
  if (!spotify.authed()) return;
  sugTimer = setTimeout(async () => {
    const found = await spotify.searchArtists(q).catch(() => []);
    if (app.g !== g || g.text.trim() !== q) return;
    const list = mine.slice();
    for (const name of found) add(list, name);
    g.sug = list;
    update();
  }, 250);
}

// Takım oyununda sırası gelenin yanıtı: bildi ya da bilemedi (yanlış tahmin, pas).
function sendTurn(ok) {
  const st = app.st;
  if (st?.phase !== 'guess' || !coop(st) || st.rd.turn !== me.id || app.g.sent === st.rd.gs) return;
  app.g.sent = st.rd.gs;
  sendToCore({ t: 'g', r: st.rd.n, ok: ok ? 1 : 0, s: st.rd.gs });
  update();
}

// Tahmin turunu bitirir (bildi ya da pes etti) ve şarkının tamamını açar.
function finishGuess(ok) {
  const st = app.st;
  if (st?.phase !== 'guess' || hasGuessed(st)) return;
  if (coop(st)) return sendTurn(ok);
  const cover = st.set.mode === 'cover';
  if (cover) app.g.stage = coverStage(st);
  app.g.done = ok ? 'ok' : 'fail';
  sendToCore({ t: 'g', r: st.rd.n, ok: ok ? 1 : 0, s: app.g.stage });
  // Kapak bulmacasında şarkı ancak herkes bitirince çalar: ses diğerlerine ipucu olurdu.
  if (!cover) playback.play({ id: st.rd.id, pos: st.rd.meta?.at || 0 });
  update();
}

function submitVote(force) {
  const st = app.st;
  if (!st?.rd || st.phase !== 'vote' || hasVoted(st)) return;
  const known = new Set(st.pl.map((p) => p.id));
  const ballot = [...app.ballot].filter((id) => known.has(id));
  if (!ballot.length && !force) return toast('Önce bir ya da birkaç oyuncu seç');
  app.voteSent = rid(st);
  sendToCore({ t: 'v', r: st.rd.n, b: ballot });
  update();
}

async function keepAwake() {
  if (wakeLock || !navigator.wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch {}
}

function releaseWake() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

// ---------- eylemler ----------

function openModal(name, data = {}) {
  app.modal = { name, ...data };
  if (name === 'audio') refreshDevices();
  update();
}

// Oyuncunun Spotify cihazlarını getirir. `auto` ile çağrılınca, oyuncu henüz bir seçim
// yapmadıysa şu an açık olan cihazı kendisi seçer.
async function refreshDevices(auto = false) {
  if (!spotify.authed() || app.devBusy) return;
  app.devBusy = true;
  update();
  try {
    // Bu sekmenin kendi oynatıcısı da Spotify'da cihaz olarak görünür; listede gösterme.
    // Başka bir sekmeden ya da önceki açılıştan kalan "Ivory" oynatıcıları da ayıklanır.
    app.devices = (await spotify.devices()).filter((d) => d.id !== playback.localId && !d.name.startsWith('Ivory'));
  } catch {
    app.devices = [];
  }
  app.devBusy = false;
  const list = app.devices;
  const open = list.find((d) => d.is_active) || (list.length === 1 ? list[0] : null);
  if (playback.mode === 'device' && !list.some((d) => d.id === playback.device)) {
    // Kayıtlı cihaz artık listede yok.
    if (open || list[0]) playback.setMode('device', (open || list[0]).id);
    else if (!app.s) playback.setMode('web');
  } else if (auto && !app.devPicked && playback.mode === 'web' && open) {
    playback.setMode('device', open.id);
  }
  update();
}

const actions = {
  create: () => openPrep({ kind: 'create' }),
  join: () => {
    if (app.code.length === CODE_LEN) openPrep({ kind: 'join', code: app.code });
  },
  home: () => {
    app.view = 'home';
    app.intent = null;
    app.autoGo = false;
    history.replaceState(null, '', location.pathname);
    update();
  },
  source: ({ v }) => {
    app.source = v;
    app.libErr = null;
    if (v === 'spotify' && spotify.authed() && !app.spot) loadSpotify();
    update();
  },
  connect: () => {
    const name = cleanName(me.name);
    if (name) setName(name);
    ss.del('tried');
    spotify.login(spotify.group(), { intent: app.intent, name: me.name });
  },
  reload: () => {
    ss.del('tried');
    app.spot = null;
    loadSpotify();
  },
  'send-mail': async () => {
    const mail = app.mail.trim();
    if (!MAIL.test(mail)) return toast('Geçerli bir e-posta yaz');
    await copyText(mail);
    if (app.intent?.kind === 'join') {
      askHost(app.intent.code, mail);
      app.mailSent = true;
      toast('E-postan odayı kuran kişiye iletildi', 'good');
    } else {
      toast('E-posta kopyalandı', 'good');
    }
    update();
  },
  'ask-copy': async ({ i }) => {
    const ask = app.asks[Number(i)];
    if (ask) toast((await copyText(ask.mail)) ? `${ask.mail} kopyalandı` : 'Kopyalanamadı', 'good');
  },
  'ask-del': ({ i }) => {
    app.asks.splice(Number(i), 1);
    if (!app.asks.length) app.modal = null;
    saveAsks();
  },
  logout: () => {
    spotify.logout();
    app.spot = null;
    app.libErr = null;
    update();
  },
  go,
  'copy-link': async () => {
    toast((await copyText(inviteLink(app.s.code))) ? 'Davet linki kopyalandı' : 'Kopyalanamadı', 'good');
  },
  'copy-code': async () => {
    toast((await copyText(app.s.code)) ? 'Oda kodu kopyalandı' : 'Kopyalanamadı', 'good');
  },
  share: () => {
    navigator.share?.({ title: 'Ivory', text: `Ivory odama katıl — kod: ${app.s.code}`, url: inviteLink(app.s.code) }).catch(() => {});
  },
  set: ({ k, v }) => {
    const set = app.st.set;
    if (k === 'mode') app.s.core.setSettings({ mode: v });
    else if (k === 'src') app.s.core.setSettings({ src: set.src ^ Number(v) });
    else if (k === 'win' || k === 'time') app.s.core.setSettings({ [k]: Number(v) });
    else app.s.core.setSettings({ [k]: v === '1' });
  },
  start: () => {
    const can = app.s.core.canStart();
    if (!can.ok) return toast(can.why);
    app.s.core.start();
  },
  kick: ({ id }) => openModal('kick', { id }),
  'kick-yes': () => {
    app.s.core.kick(app.modal.id);
    app.modal = null;
    update();
  },
  'leave-yes': () => {
    if (isHost()) app.s.core.close();
    else app.s.core.leave();
    endSession();
  },
  pick: ({ id }) => {
    const st = app.st;
    if (st?.phase !== 'vote' || hasVoted(st)) return;
    if (app.ballot.has(id)) app.ballot.delete(id);
    else app.ballot.add(id);
    update();
  },
  vote: () => submitVote(false),
  cont: () => {
    const st = app.st;
    if (st?.phase !== 'reveal' || hasContinued(st)) return;
    app.contSent = rid(st);
    sendToCore({ t: 'c', r: st.rd.n });
    update();
  },
  replay: () => {
    if (app.st?.phase === 'guess' && !hasGuessed(app.st)) playSnippet();
  },
  more: () => {
    const st = app.st;
    if (st?.phase !== 'guess' || coop(st) || hasGuessed(st) || app.g.stage >= GUESS_STEPS.length - 1) return;
    app.g.stage++;
    playSnippet();
    update();
  },
  giveup: () => finishGuess(false),
  bet: ({ k }) => {
    const st = app.st;
    if (st?.phase !== 'bet' || st.rd.duel.includes(me.id)) return;
    app.g.bet = Number(k);
    sendToCore({ t: 'b', r: st.rd.n, k: app.g.bet });
    update();
  },
  // Düellocunun atışı: "şarkıyı bu kişi dinliyor". Sonucu host söyler.
  shot: ({ id }) => {
    const st = app.st;
    if (st?.phase !== 'duel' || !st.rd.duel.includes(me.id) || app.g.fired || app.g.jam > Date.now()) return;
    app.g.fired = id;
    sendToCore({ t: 'g', r: st.rd.n, w: id });
    update();
  },
  sug: ({ i }) => {
    const pick = app.g.sug?.[Number(i)];
    const el = $('[data-model="guess"]');
    if (!pick || !el) return;
    clearTimeout(sugTimer);
    app.g.text = el.value = pick.name;
    app.g.pick = pick;
    app.g.sug = [];
    el.focus();
    update();
  },
  guess: () => {
    const st = app.st;
    const text = app.g.text.trim();
    if (st?.phase !== 'guess' || hasGuessed(st) || !text || app.g.jam > Date.now()) return;
    if (coop(st) && st.rd.turn !== me.id) return;
    clearTimeout(sugTimer);
    app.g.sug = [];
    if (isRight(text, st)) return finishGuess(true);
    app.g.text = '';
    // Kapak bulmacasında yanlış tahmin kısa bir bekleme getirir: rastgele deneme olmasın.
    if (st.set.mode === 'cover') app.g.jam = Date.now() + 2000;
    if (coop(st)) {
      toast('Bu değil — sıra geçiyor');
      return sendTurn(false);
    }
    const el = $('[data-model="guess"]');
    if (el) {
      el.value = '';
      el.animate([{ transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(-3px)' }, { transform: 'none' }], 320);
    }
    toast('Bu değil, bir daha dene');
  },
  react: ({ e }) => {
    if (app.s) sendToCore({ t: 'rx', e: Number(e) });
  },
  again: () => actions.start(),
  lobby: () => app.s.core.toLobby(),
  save: async () => {
    const rd = app.st?.rd;
    if (!rd || app.saving || app.savedRound === rid(app.st)) return;
    app.saving = true;
    update();
    try {
      const list = await spotify.saveTrack(rd.id);
      app.savedRound = rid(app.st);
      toast(`“${list}” listene eklendi`, 'good');
      sendToCore({ t: 'sv' });
    } catch (e) {
      toast(e.status === 403 ? 'Listeye eklenemedi (izin yok)' : 'Listeye eklenemedi');
    }
    app.saving = false;
    update();
  },
  modal: ({ m }) => openModal(m),
  close: () => {
    app.modal = null;
    update();
  },
  'audio-mode': ({ v }) => {
    app.devPicked = true;
    playback.setMode(v);
    update();
  },
  'dev-refresh': () => refreshDevices(),
  'dev-pick': ({ id }) => {
    app.devPicked = true;
    playback.setMode('device', id);
    update();
  },
  unmute: () => playback.resume(),
  'copy-uri': async () => {
    toast((await copyText(spotify.redirectUri())) ? 'Adres kopyalandı' : 'Kopyalanamadı', 'good');
  },
};

const models = {
  guess: (value) => {
    app.g.text = value.slice(0, 80);
    suggest(app.g.text);
  },
  vol: (value) => playback.setVolume(value / 100),
  code: (value, el) => {
    app.code = cleanCode(value);
    if (el.value !== app.code) el.value = app.code;
    update();
  },
  mail: (value) => {
    app.mail = value.slice(0, 120);
    app.mailSent = false;
    update();
  },
  name: (value) => {
    me.name = value.slice(0, 14);
    ss.set('name', cleanName(me.name));
    update();
  },
};

// ---------- ekranlar ----------

const MARK = '<span class="mark" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>';

function homeView() {
  return `
  <main class="home" data-key="home">
    <div class="hero">
      ${MARK}
      <h1 class="logo">ivory</h1>
      <p class="tagline">Şarkı çalıyor. Peki kimin listesinden?</p>
    </div>
    <div class="home-actions">
      <button class="btn primary xl" data-act="create">Oda kur</button>
      <form class="joinbox" data-submit="join">
        <input class="code-in" data-model="code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="${CODE_LEN}" placeholder="ODA KODU" value="${esc(app.code)}" aria-label="Oda kodu">
        <button class="btn xl" ${app.code.length === CODE_LEN ? '' : 'disabled'}>Katıl</button>
      </form>
    </div>
    <ul class="steps">
      <li><b>1</b><div><h4>Odayı kur, linki paylaş</h4><p>${CFG.maxPlayers} kişiye kadar. Uygulama indirmek gerekmez.</p></div></li>
      <li><b>2</b><div><h4>Şarkı çalar, herkes oy verir</h4><p>Kimlerin listesinde olduğunu düşünüyorsan onları seç.</p></div></li>
      <li><b>3</b><div><h4>Doğru +3, yanlış −1</h4><p>Hedef puana ilk ulaşan kazanır.</p></div></li>
    </ul>
    <footer class="foot">
      <button class="link" data-act="modal" data-m="how">Nasıl oynanır?</button>
    </footer>
  </main>`;
}

function sourceCount(tracks) {
  const n = { [FL]: 0, [PL]: 0, [AL]: 0 };
  for (const t of tracks) for (const bit of [FL, PL, AL]) if (t.f & bit) n[bit]++;
  return `Sık dinlenen ${n[FL]} · Liste ${n[PL]} · Albüm ${n[AL]}`;
}

function spotifyBody() {
  if (!spotify.configured()) {
    return `<p class="note">Bu sitede Spotify bağlantısı henüz ayarlanmamış. Siteyi yayınlayan kişinin bir kez kurulum yapması gerekiyor. <button class="link" data-act="modal" data-m="setup">Site sahibi için adımlar</button></p>`;
  }
  if (app.busy) {
    return `<div class="loading"><span class="spinner"></span><div><b>${esc(app.busy.label)} okunuyor…</b><span>${app.busy.count} şarkı bulundu</span></div></div>`;
  }
  if (app.libErr) {
    if (app.libErr.kind === 'unreg') {
      // Spotify, geliştirme modundaki uygulamaya yalnızca elle eklenen hesapları kabul eder ve
      // eklenmemiş hesabın e-postasını bize vermez; oyuncu onu bir kez kendisi yazar.
      const join = app.intent?.kind === 'join';
      const hint = app.mailSent
        ? '<b class="up">İletildi.</b> Seni ekleyince aşağıdan tekrar dene.'
        : join
          ? 'E-postan yalnızca odayı kuran kişiye gider.'
          : 'Kopyalayıp siteyi kuran kişiye gönder.';
      return `<p class="note bad"><b>Bu Spotify hesabı henüz oyuna eklenmemiş.</b> Odayı kuran kişinin seni ekleyebilmesi için Spotify hesabının e-postası gerekiyor.</p>
        <ol class="mailsteps">
          <li>
            <a class="btn sm" href="https://www.spotify.com/account/profile/" target="_blank" rel="noopener">Spotify e-postamı göster</a>
            <span>Açılan sayfadaki e-postayı kopyala.</span>
          </li>
          <li>
            <div class="mailrow">
              <input data-model="mail" type="email" inputmode="email" autocomplete="email" autocapitalize="off" spellcheck="false" placeholder="Spotify e-postan" value="${esc(app.mail)}" aria-label="Spotify e-postan">
              <button class="btn sm primary" data-act="send-mail" ${MAIL.test(app.mail.trim()) ? '' : 'disabled'}>${join ? 'Gönder' : 'Kopyala'}</button>
            </div>
            <span>${hint}</span>
          </li>
        </ol>
        <div class="mini-actions">
          <button class="btn sm" data-act="reload">Eklendim, tekrar dene</button>
          <button class="link" data-act="logout">Başka hesapla dene</button>
        </div>`;
    }
    return `<p class="note bad">${app.libErr.kind === 'auth' ? 'Spotify oturumu sona erdi.' : 'Şarkılar okunamadı: ' + esc(app.libErr.text || '')}</p>
      <div class="mini-actions"><button class="btn sm" data-act="${app.libErr.kind === 'auth' ? 'connect' : 'reload'}">Tekrar dene</button></div>`;
  }
  if (app.spot) {
    const warn = app.spot.warn?.length ? `<p class="note">Okunamayan kaynak: ${esc(app.spot.warn.join(', '))}</p>` : '';
    return `<div class="ready">${icon('check')}<div><b>${app.spot.tracks.length} şarkı hazır</b><span>${esc(app.spot.user?.name || '')} · ${sourceCount(app.spot.tracks)}</span></div></div>${warn}
      <div class="mini-actions"><button class="link" data-act="reload">Şarkıları yenile</button><button class="link" data-act="logout">Hesabı değiştir</button></div>
      <div class="where">
        <h4>Spotify nerede açık?</h4>
        ${devicePicker()}
      </div>`;
  }
  return `
    <button class="btn spotify" data-act="connect">Spotify ile bağlan</button>
    <p class="note">Sık dinlediklerin, oluşturduğun listeler ve kayıtlı albümlerin okunur. Şarkı listen yalnızca bu oyun için odadaki host'a gider; hiçbir sunucuda saklanmaz.</p>`;
}

function prepView() {
  const join = app.intent.kind === 'join';
  const demo = app.source === 'demo';
  let cta = join ? `${esc(app.intent.code)} odasına katıl` : 'Odayı kur';
  let off = false;
  if (cleanName(me.name).length < 2) {
    cta = 'Önce kullanıcı adını yaz';
    off = true;
  } else if (!demo) {
    if (!spotify.configured()) {
      cta = 'Spotify henüz ayarlanmadı';
      off = true;
    } else if (app.busy) {
      cta = 'Şarkıların okunuyor…';
      off = true;
    } else if (app.libErr) off = true;
  }
  // Spotify'a bağlanmadan önce tek düğme paneldeki "Spotify ile bağlan"dır; bağlandıktan
  // sonra oyuncu cihazını seçer ve bu düğmeyle odaya girer.
  const showCta = demo || spotify.authed();
  // Yalnızca yerel denemede görünen kaynak değiştirici.
  const testSwitch = DEMO
    ? `<div class="seg"><button class="${demo ? '' : 'on'}" data-act="source" data-v="spotify">Spotify</button><button class="${demo ? 'on' : ''}" data-act="source" data-v="demo">Test şarkıları</button></div>`
    : '';
  return `
  <main class="prep" data-key="prep">
    <button class="back" data-act="home">${icon('back')} Geri</button>
    <h2>${join ? `<span class="mono">${esc(app.intent.code)}</span> odasına katılıyorsun` : 'Yeni oda kuruyorsun'}</h2>
    <label class="field nick">
      <span>Kullanıcı adın</span>
      <input data-model="name" maxlength="14" autocomplete="off" autocapitalize="words" spellcheck="false" enterkeyhint="done" placeholder="Odada bu adla görüneceksin" value="${esc(me.name)}">
      <em>${join ? 'Odadaki herkes seni bu adla görecek.' : 'Oyuncular seni bu adla görecek.'}</em>
    </label>
    ${testSwitch}
    ${demo ? '' : `<section class="panel"><h3>Spotify hesabın</h3>${spotifyBody()}</section>`}
    ${showCta ? `<button class="btn primary xl" data-act="go" ${off ? 'disabled' : ''}>${cta}</button>` : ''}
  </main>`;
}

function barView() {
  const quiet = playback.mode === 'none';
  return `
  <header class="bar" data-key="bar">
    <div class="brand">${MARK}<span>ivory</span></div>
    <div class="bar-right">
      ${isHost() && app.asks.length ? `<button class="pill warn" data-act="modal" data-m="asks" title="Giriş isteyenler">${app.asks.length} istek</button>` : ''}
      <button class="pill" data-act="copy-link" title="Davet linkini kopyala"><span class="mono">${esc(app.s.code)}</span>${icon('link')}</button>
      <button class="icon-btn ${quiet ? 'dim' : ''}" data-act="modal" data-m="audio" aria-label="Ses ayarı">${icon(quiet ? 'mute' : 'sound')}</button>
      <button class="icon-btn" data-act="modal" data-m="leave" aria-label="Odadan ayrıl">${icon('exit')}</button>
    </div>
  </header>`;
}

function connectingView() {
  const late = Date.now() - app.joinAt > JOIN_PATIENCE_MS;
  return `
  <main class="center" data-key="connecting">
    <span class="spinner big"></span>
    <h2><span class="mono">${esc(app.s.code)}</span> odasına bağlanılıyor…</h2>
    ${
      late
        ? `<p class="note">Oda henüz yanıt vermedi. Kod doğru mu? Odayı kuran kişinin sayfası açık olmalı. Denemeye devam ediyorum.</p>`
        : `<p class="note">${app.s.chan.online ? 'Host bekleniyor' : 'Bağlantı kuruluyor'}</p>`
    }
    <button class="btn" data-act="leave-yes">Vazgeç</button>
  </main>`;
}

function playerStatus(p) {
  if (!p.on) return 'bağlantı koptu';
  if (!p.ok) return 'şarkıları yükleniyor…';
  if (!p.n) return 'şarkı bulunamadı';
  const how = p.mode === 'demo' ? ' · test' : '';
  return `${p.n} şarkı${how}`;
}

function settingsView(st, host) {
  const set = st.set;
  const seg = (k, options, current) =>
    `<div class="seg">${options
      .map(([v, label]) => `<button class="${String(current) === String(v) ? 'on' : ''}" ${host ? `data-act="set" data-k="${k}" data-v="${v}"` : 'disabled'}>${label}</button>`)
      .join('')}</div>`;
  const name = set.mode === 'name';
  return `
    <div class="set-row"><span>Oyun modu</span>${seg('mode', [['who', 'Kim dinliyor?'], ['name', 'Şarkıyı bil'], ['duel', 'Düello'], ['cover', 'Kapak bulmacası']], set.mode)}</div>
    ${name ? `<div class="set-row"><span>Nasıl oynansın?</span>${seg('team', [['0', 'Bireysel'], ['1', 'Tek takım']], set.team ? '1' : '0')}</div>` : ''}
    <div class="set-row">
      <span>Hangi şarkılar kullanılsın?</span>
      <div class="seg multi">${SOURCES.map(
        (s) => `<button class="${set.src & s.bit ? 'on' : ''}" ${host ? `data-act="set" data-k="src" data-v="${s.bit}"` : 'disabled'} aria-pressed="${!!(set.src & s.bit)}">${s.label}</button>`
      ).join('')}</div>
    </div>
    <div class="set-row"><span>Kaç puana kadar?</span>${seg('win', (set.mode === 'duel' ? DUEL_WIN_OPTIONS : WIN_OPTIONS).map((v) => [v, v]), set.win)}</div>
    ${
      set.mode !== 'who'
        ? ''
        : `<div class="set-row"><span>Oy süresi</span>${seg('time', TIME_OPTIONS.map((v) => [v, v + ' sn']), set.time)}</div>
    <div class="set-row"><span>Şarkı nereden başlasın?</span>${seg('mid', [['1', 'Ortadan'], ['0', 'Baştan']], set.mid ? '1' : '0')}</div>`
    }
    <div class="set-row"><span>Explicit şarkılar</span>${seg('ex', [['1', 'Çalsın'], ['0', 'Çalmasın']], set.ex ? '1' : '0')}</div>`;
}

function lobbyView(st) {
  const host = isHost();
  const hostP = st.pl.find((p) => p.id === st.host);
  const can = host ? app.s.core.canStart() : null;
  const teams = teamsOn(st);
  const rules =
    st.set.mode === 'cover'
      ? `<li>Bir albüm kapağı çok bulanık başlar ve adım adım netleşir. <b>Ses çalmaz.</b></li>
        <li>Sanatçıyı, albümü ya da şarkının adını yazarsın; üçü de doğru sayılır.</li>
        <li>${COVER_LABELS.map((label, i) => `${label} iken bilen <b class="up">+${GUESS_PTS[i]}</b>`).join(', ')}. Herkesten önce bilen <b class="up">+1</b> ek puan alır.</li>
        <li>Yanlış tahmin 2 saniye bekletir. Herkes bitirince şarkı çalar.</li>
        <li><b>${st.set.win} puana</b> ilk ulaşan kazanır.</li>`
      : st.set.mode === 'duel'
      ? `<li>Her turda iki oyuncu karşı karşıya gelir. Yalnızca <b>bir kişinin</b> dinlediği bir şarkı çalar; o kişinin kim olduğunu <b>ilk bilen</b> ateş eder.</li>
        <li>Diğerleri önce bahis oynar: kimin kazanacağını düşünüyorsan paranı onun yanına koyarsın.</li>
        <li>Düelloyu kazanan <b class="up">+3</b>, ayrıca rakibine oynanan her para için <b class="up">+1</b> alır. Kazanana oynayan <b class="up">+2</b> alır.</li>
        <li>Az bahis alan taraf kazanırsa bu ödüller <b class="up">iki katı</b> olur. Yanlış tahmin silahı ${JAM_MS / 1000} saniye tutuklar.</li>
        <li><b>${st.set.win} puana</b> ilk ulaşan kazanır.</li>`
      : st.set.mode === 'name'
      ? `<li>Şarkının ilk <b>${GUESS_STEPS[0]} saniyesi</b> çalar; adını yazıp tahmin edersin.</li>
        ${
          teams
            ? `<li>Herkes aynı takımda; sırayla tahmin edilir. Sırası gelen bilemezse şarkı ${GUESS_STEPS[1]}, sonra ${GUESS_STEPS[2]} saniye çalar ve sıra bir sonrakine geçer.</li>
        <li>${GUESS_STEPS.map((sec, i) => `${sec} sn'de bilinirse <b class="up">+${GUESS_PTS[i]}</b>`).join(', ')}. Üçüncü oyuncu da bilemezse o şarkıdan puan yok.</li>
        <li>Hedef, takım olarak <b>${st.set.win} puana</b> en az şarkıda ulaşmak.</li>`
            : `<li>Bilemezsen “Biraz daha” ile ${GUESS_STEPS[1]}, sonra ${GUESS_STEPS[2]} saniye dinlersin. Sözlerden ipucu da çıkar.</li>
        <li>${GUESS_STEPS.map((sec, i) => `${sec} sn'de bilen <b class="up">+${GUESS_PTS[i]}</b>`).join(', ')}. Pes edersen puan yok.</li>
        <li>Şarkıyı herkesten önce bilen <b class="up">+1</b> ek puan alır.</li>
        <li><b>${st.set.win} puana</b> ilk ulaşan kazanır.</li>`
        }`
      : `<li>Şarkı çalınca, onu dinlediğini düşündüğün herkesi seç — kendin dahil.</li>
        <li>Aynı şarkıyı birkaç kişi dinliyor olabilir; istediğin kadar isim seçebilirsin.</li>
        <li>Her doğru isim <b class="up">+3</b>, her yanlış isim <b class="down">−1</b> puan.</li>
        <li><b>${st.set.win} puana</b> ilk ulaşan kazanır.</li>`;
  return `
  <main class="lobby" data-key="lobby">
    <section class="card invite">
      <div>
        <span class="label">Oda kodu</span>
        <button class="code" data-act="copy-code" title="Kodu kopyala">${[...st.code].map((c) => `<i>${c}</i>`).join('')}</button>
      </div>
      <div class="invite-actions">
        <button class="btn primary" data-act="copy-link">${icon('link')} Davet linkini kopyala</button>
        ${navigator.share ? `<button class="btn" data-act="share">${icon('share')} Paylaş</button>` : ''}
      </div>
    </section>
    <div class="cols">
      <section class="card">
        <h3>Oyuncular <span class="count">${st.pl.length}/${st.max}</span></h3>
        <ul class="plist">
          ${st.pl
            .map(
              (p) => `
            <li class="${p.on ? '' : 'off'}" data-key="p-${p.id}">
              ${av(p)}
              <div class="p-main">
                <b>${esc(p.name)}${p.id === me.id ? '<em>sen</em>' : ''}${p.id === st.host ? `<em class="host">${icon('crown')} host</em>` : ''}</b>
                <span>${playerStatus(p)}</span>
              </div>
              ${host && p.id !== me.id ? `<button class="icon-btn sm" data-act="kick" data-id="${p.id}" aria-label="${esc(p.name)} oyuncusunu çıkar">${icon('x')}</button>` : ''}
            </li>`
            )
            .join('')}
        </ul>
      </section>
      <section class="card">
        <h3>Oyun ayarları ${host ? '' : '<span class="count">host belirler</span>'}</h3>
        ${settingsView(st, host)}
      </section>
    </div>
    <section class="card rules">
      <h3>Nasıl oynanır?</h3>
      <ol>
        ${rules}
      </ol>
    </section>
    <div class="dock">
      ${
        host
          ? `<button class="btn primary xl" data-act="start" ${can.ok ? '' : 'disabled'}>Oyunu başlat</button>${can.ok ? '' : `<p class="note">${can.why}</p>`}`
          : `<p class="waiting"><span class="pulse"></span>${esc(hostP?.name || 'Host')} oyunu başlatacak</p>`
      }
    </div>
  </main>`;
}

function boardView(st, P) {
  const reveal = st.phase === 'reveal';
  const rd = st.rd;
  const ls = new Set(reveal ? rd.ls : []);
  const rows = st.pl.slice().sort((a, b) => b.sc - a.sc || a.name.localeCompare(b.name, 'tr'));
  const named = st.set.mode === 'name' || st.set.mode === 'cover';
  const when = (stage) => (st.set.mode === 'cover' ? COVER_LABELS[stage].toLocaleLowerCase('tr') + 'ken' : `${GUESS_STEPS[stage]} sn'de`);
  const teams = teamsOn(st) && st.ts != null;
  const teamTiles = teams
    ? `<div class="teams"><div style="--w:${(clamp01(st.ts / st.set.win) * 100).toFixed(1)}%"><span>Takım puanı</span>${reveal && rd.td != null ? `<em class="${rd.td ? 'up' : ''}">${signed(rd.td)}</em>` : ''}<b>${st.ts}</b></div></div>`
    : '';
  return `
  <section class="card board">
    <h3>Puan durumu <span class="count">hedef ${st.set.win}</span></h3>
    ${teamTiles}
    <ol>
      ${rows
        .map((p, i) => {
          const delta = reveal ? rd.dl?.[p.id] : null;
          const ballot = reveal ? rd.vt?.[p.id] : null;
          const res = reveal && rd.res ? rd.res[p.id] : null;
          const duelTag = rd?.duel ? (rd.duel.includes(p.id) ? 'düellocu' : rd.bets[p.id] != null ? `bahis: ${esc(P.get(rd.duel[rd.bets[p.id]])?.name || '')}` : '') : '';
          const votes = rd?.duel
            ? reveal
              ? `<span class="votes"><em>${duelTag}</em></span>`
              : ''
            : named
            ? reveal
              ? `<span class="votes"><em>${res ? (res[0] ? `${when(res[1])} bildi${rd.first === p.id && !teams ? ' · ilk' : ''}` : 'bilemedi') : teams ? '' : 'yanıt yok'}</em></span>`
              : ''
            : reveal
            ? `<span class="votes">${
                ballot
                  ? ballot.map((id) => (P.get(id) ? `<span class="av ${ls.has(id) ? 'ok' : 'no'}" title="${esc(P.get(id).name)} · ${ls.has(id) ? 'dinliyor' : 'dinlemiyor'}">${esc(initial(P.get(id).name))}</span>` : '')).join('') || '<em>boş oy</em>'
                  : '<em>oy yok</em>'
              }</span>`
            : '';
          return `
        <li class="${p.id === me.id ? 'me' : ''} ${p.on ? '' : 'off'}" data-key="b-${p.id}" style="--h:${p.hue};--w:${(clamp01(p.sc / st.set.win) * 100).toFixed(1)}%">
          <span class="rank">${i + 1}</span>
          ${av(p)}
          <span class="who">${esc(p.name)}</span>
          ${votes}
          ${delta != null ? `<span class="delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}">${signed(delta)}</span>` : ''}
          <span class="score">${p.sc}</span>
          ${isHost() && p.id !== me.id ? `<button class="icon-btn xs" data-act="kick" data-id="${p.id}" aria-label="${esc(p.name)} oyuncusunu çıkar">${icon('x')}</button>` : ''}
        </li>`;
        })
        .join('')}
    </ol>
  </section>`;
}

// ---------- çark ----------

const R_OUT = 97;
const R_IN = 37;
const polar = (r, deg) => [r * Math.cos((deg * Math.PI) / 180), r * Math.sin((deg * Math.PI) / 180)];
const n2 = (x) => x.toFixed(2);

function slicePath(a0, a1) {
  const [x0, y0] = polar(R_OUT, a0);
  const [x1, y1] = polar(R_OUT, a1);
  const [x2, y2] = polar(R_IN, a1);
  const [x3, y3] = polar(R_IN, a0);
  const big = a1 - a0 > 180 ? 1 : 0;
  return `M${n2(x0)} ${n2(y0)}A${R_OUT} ${R_OUT} 0 ${big} 1 ${n2(x1)} ${n2(y1)}L${n2(x2)} ${n2(y2)}A${R_IN} ${R_IN} 0 ${big} 0 ${n2(x3)} ${n2(y3)}Z`;
}

function clip(name, max) {
  const chars = [...name];
  return chars.length > max ? chars.slice(0, Math.max(1, max - 1)).join('') + '…' : name;
}

// Oyuncular çarkın dilimleridir. Dilime dokununca seçilir ve dışarı doğru çıkar;
// açıklamada şarkıyı dinleyenlerin dilimleri öne çıkar.
function wheelView(st, { reveal, locked, mine, listeners }) {
  const n = st.pl.length;
  const step = 360 / n;
  const flat = n <= 6;
  const slices = st.pl
    .map((p, i) => {
      const a0 = -90 + i * step;
      const a1 = a0 + (n === 1 ? 359.9 : step);
      const mid = a0 + step / 2;
      const [ux, uy] = polar(1, mid);
      const sel = mine.has(p.id);
      const is = listeners.has(p.id);
      const cls = ['slice'];
      if (!p.on) cls.push('off');
      let badge = ''; // oylama sırasında: seçtim (✓) ya da bu oyuncu oyunu verdi (•)
      let score = ''; // açıklamada: bu tahminden aldığım puan
      if (reveal) {
        if (is) cls.push('listener');
        if (sel) cls.push(is ? 'hit' : 'miss');
        score = sel ? (is ? '+3' : '−1') : '';
      } else {
        if (sel) cls.push('sel');
        badge = sel ? '✓' : st.rd.voted.includes(p.id) ? '•' : '';
      }

      let label;
      let bx;
      let by;
      if (flat) {
        const [cx, cy] = n === 1 ? [0, -67] : polar(67, mid);
        const fs = [...p.name].length > 9 ? 7 : 8.6;
        const room = n <= 2 ? 14 : Math.floor((2 * 67 * Math.sin((step * Math.PI) / 360) * 0.82) / (fs * 0.58));
        // Puan, adın hemen altına yazılır.
        label = `<text x="${n2(cx)}" y="${n2(cy - (score ? fs * 0.6 : 0))}" font-size="${fs}">${esc(clip(p.name, room))}</text>`;
        if (score) label += `<text class="pts" x="${n2(cx)}" y="${n2(cy + fs * 0.85)}" font-size="${n2(fs * 1.3)}">${score}</text>`;
        [bx, by] = [cx, cy + fs + 4.5];
      } else {
        const fs = n <= 10 ? 7.2 : n <= 16 ? 6.4 : 5.8;
        const [cx, cy] = polar(63, mid);
        const turn = ((mid % 360) + 360) % 360;
        const rot = turn > 90 && turn < 270 ? mid + 180 : mid;
        label = `<text transform="translate(${n2(cx)} ${n2(cy)}) rotate(${n2(rot)})" font-size="${fs}">${esc(clip(p.name, Math.floor(44 / (fs * 0.58))))}</text>`;
        [bx, by] = polar(90.5, mid);
        // Kalabalık çarkta ad dilim boyunca döner; puan dilimin dış ucunda durur.
        if (score) badge = score;
      }

      const rim = R_OUT + 2.6;
      const [m0x, m0y] = polar(rim, a0 + 1.2);
      const [m1x, m1y] = polar(rim, a1 - 1.2);
      const meArc = p.id === me.id ? `<path class="me-arc" d="M${n2(m0x)} ${n2(m0y)}A${rim} ${rim} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${n2(m1x)} ${n2(m1y)}"/>` : '';
      const dot = badge === '•';
      const mark = badge
        ? `<g class="pin ${dot ? 'dot' : ''}" data-key="pin${badge}" transform="translate(${n2(bx)} ${n2(by)})"><circle r="${dot ? 2.4 : badge.length > 1 ? 6.2 : 5.4}"/>${dot ? '' : `<text font-size="${badge.length > 1 ? 5.6 : 6}">${badge}</text>`}</g>`
        : '';
      return `<g class="${cls.join(' ')}" data-key="s-${p.id}" style="--h:${p.hue};--dx:${n2(ux * 4)}px;--dy:${n2(uy * 4)}px" data-act="pick" data-id="${p.id}" role="button" tabindex="${locked ? -1 : 0}" aria-pressed="${sel}" aria-label="${esc(p.name)}${p.id === me.id ? ' (sen)' : ''}"><path class="bg" d="${slicePath(a0, a1)}"/>${meArc}${label}${mark}</g>`;
    })
    .join('');
  return `<svg class="wheel ${reveal ? 'is-reveal' : ''} ${locked ? 'locked' : ''}" viewBox="-110 -110 220 220" role="group" aria-label="Oyuncular">${slices}</svg>`;
}

// Gömülü oynatıcının yeri ve ses kaydırıcısı. `secret` ile oynatıcı görünmez kalır:
// "şarkıyı bil" turunda şarkının adını ve kapağını göstermesin.
function audioView(rd, m, secret = false) {
  const demo = isDemo(rd.id);
  // Kutu yalnızca şarkı gerçekten gömülü oynatıcıda çalarken görünür; yoksa boş bir kutu kalır.
  const embedOn = !demo && playback.via === 'embed' && playback.mode !== 'none';
  // Ses ayarlı sekme oynatıcısı yerine gömülü oynatıcıya düşüldüyse nedenini söyle.
  let noVol = '';
  if (embedOn && playback.via === 'embed' && spotify.authed()) {
    noVol = !spotify.canStream()
      ? 'Ses düzeyi ayarı için odadan çık, “Hesabı değiştir”e basıp Spotify\'a yeniden bağlan (yeni izin gerekiyor).'
      : playback.localWhy
        ? 'Ses ayarlı oynatıcı açılamadı: ' + esc(playback.localWhy)
        : '';
  }
  const volOn = !demo && playback.mode !== 'none' && playback.canVolume;
  const blocked = playback.status === 'blocked' && playback.mode !== 'none';
  const stuck = blocked && (playback.via === 'local' || (secret && playback.via === 'embed'));
  return `
      <div class="embed-wrap ${embedOn ? '' : 'hidden'} ${secret ? 'secret' : ''}" data-key="embedwrap">
        <div id="embed" data-key="embed" data-keep></div>
        ${embedOn && blocked && !secret ? '<p class="note">Ses gelmiyorsa oynatıcıdaki ▶ düğmesine bir kez dokun.</p>' : ''}
        ${noVol ? `<p class="note">${noVol}</p>` : ''}
      </div>
      ${secret && embedOn && playback.via === 'embed' ? '<p class="note" data-key="novol">Bu oynatıcıda ses düzeyi ayarlanamıyor; sesi cihazından kıs. (Ayar için Spotify Premium ile bağlanmak gerekir.)</p>' : ''}
      <div class="vol ${volOn || stuck ? '' : 'hidden'}" data-key="vol">
        <label class="${volOn ? '' : 'hidden'}">${icon('sound')}<input type="range" min="0" max="100" step="1" value="${Math.round(playback.level * 100)}" data-model="vol" aria-label="Ses düzeyi"></label>
        ${stuck ? '<button class="btn sm ghost" data-act="unmute">Sesi başlat</button>' : ''}
      </div>`;
}

function playView(st) {
  const rd = st.rd;
  const reveal = st.phase === 'reveal';
  const P = new Map(st.pl.map((p) => [p.id, p]));
  const m = rd.meta || meta.get(rd.id) || (isDemo(rd.id) ? demoMeta(rd.id) : null);
  const img = safeImg(m?.img);
  const left = Math.max(0, rd.t1 - hnow());
  const frac = reveal ? 0 : clamp01(left / (st.set.time * 1000));
  const secs = Math.ceil(left / 1000);
  const voted = !reveal && hasVoted(st);
  const active = st.pl.filter((p) => p.on);
  const listeners = new Set(reveal ? rd.ls : []);
  const mine = new Set(reveal ? rd.vt?.[me.id] || [] : app.ballot);
  const demo = isDemo(rd.id);
  const canSave = !demo && spotify.authed();
  const saved = app.savedRound === rid(app.st);

  let heading = 'Bu şarkı kimlerin listesinde?';
  let sub = 'Dilimlere dokunarak seç · birden fazla olabilir · doğru <b class="up">+3</b> · yanlış <b class="down">−1</b>';
  if (reveal) {
    const n = rd.ls.length;
    heading = n === st.pl.length && n > 1 ? 'Herkesin listesinde!' : n === 1 ? `Yalnızca ${esc(P.get(rd.ls[0])?.name || 'biri')} dinliyor` : `${n} kişinin listesinde`;
    const d = rd.dl?.[me.id];
    sub = d == null ? 'Bu turda oy vermedin' : `Bu turdan <b class="${d > 0 ? 'up' : d < 0 ? 'down' : ''}">${signed(d)} puan</b> aldın`;
  }

  let cta;
  if (!reveal && !voted) {
    cta = `<button class="btn primary xl" data-act="vote" ${app.ballot.size ? '' : 'disabled'}>${app.ballot.size ? `Oy ver · ${app.ballot.size} kişi` : 'Çarktan oyuncu seç'}</button>`;
  } else if (!reveal) {
    cta = `<p class="waiting"><span class="pulse"></span>Oyun alındı · ${rd.voted.filter((id) => P.get(id)?.on).length}/${active.length} oyuncu oy verdi</p>`;
  } else if (!hasContinued(st)) {
    cta = `<button class="btn primary xl" data-act="cont">Devam</button>`;
  } else {
    const waitingFor = active.filter((p) => !rd.cont.includes(p.id)).map((p) => esc(p.name));
    cta = `<p class="waiting"><span class="pulse"></span>Herkesin “Devam” demesi bekleniyor · ${active.length - waitingFor.length}/${active.length}</p>
      ${waitingFor.length ? `<p class="note">Bekleniyor: ${waitingFor.join(', ')}</p>` : ''}`;
  }

  return `
  <main class="play" data-key="play">
    <div class="play-main">
      <header class="now">
        <div class="kicker"><span>Şarkı ${rd.no}</span>${reveal ? '' : `<span class="clock ${secs <= 5 ? 'hot' : ''}">${secs} sn</span>`}</div>
        <h2 class="title">${m ? esc(m.name) : 'Şarkı çalıyor…'}</h2>
        <p class="artist">${esc(m?.artists || '')}</p>
        ${canSave ? `<button class="btn sm ghost" data-act="save" ${saved || app.saving ? 'disabled' : ''}>${icon(saved ? 'check' : 'plus')} ${saved ? 'Listene eklendi' : 'Listeme ekle'}</button>` : ''}
      </header>
      <div class="ask">
        <h3>${heading}</h3>
        <p>${sub}</p>
      </div>
      <div class="wheel-wrap">
        ${wheelView(st, { reveal, locked: reveal || voted, mine, listeners })}
        <div class="disc ${playback.status === 'playing' ? 'spin' : ''}" style="--hue:${cyrb53(rd.id) % 360}">
          <svg class="ring" viewBox="0 0 100 100" aria-hidden="true">
            <defs><linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff5d73"/><stop offset=".35" stop-color="#ffd84d"/><stop offset=".65" stop-color="#5ee6a0"/><stop offset="1" stop-color="#7c7cff"/></linearGradient></defs>
            <circle class="ring-bg" cx="50" cy="50" r="47"/>
            <circle class="ring-fg" cx="50" cy="50" r="47" style="stroke-dashoffset:${((1 - frac) * 295.3).toFixed(1)}"/>
          </svg>
          <div class="cover">${img ? `<img src="${esc(img)}" alt="" referrerpolicy="no-referrer">` : '<span>♪</span>'}</div>
        </div>
      </div>
      <div class="legend ${reveal ? '' : 'hidden'}"><span><i class="g"></i>dinliyor</span><span><i class="r"></i>yanlış tahminin</span></div>
      ${audioView(rd, m)}
      ${reveal ? reactBar() : ''}
      <div class="dock">${cta}</div>
    </div>
    ${boardView(st, P)}
  </main>`;
}

function saveButton(rd) {
  if (isDemo(rd.id) || !spotify.authed()) return '';
  const saved = app.savedRound === rid(app.st);
  return `<button class="btn sm ghost" data-act="save" ${saved || app.saving ? 'disabled' : ''}>${icon(saved ? 'check' : 'plus')} ${saved ? 'Listene eklendi' : 'Listeme ekle'}</button>`;
}

// Oynatıcı tahmin ve açıklama ekranlarında hep ilk sırada durur (yeri CSS ile aşağı alınır):
// yeri değişirse tarayıcı gömülü oynatıcıyı yeniden yükler ve ses kesilir.
// "Şarkıyı bil" turu: herkes kendi hızında dinler, tahmin eder, gerekirse bir sonraki aşamaya geçer.
function guessView(st) {
  const rd = st.rd;
  const g = app.g;
  const P = new Map(st.pl.map((p) => [p.id, p]));
  const m = rd.meta;
  const left = Math.max(0, rd.t1 - hnow());
  const secs = Math.ceil(left / 1000);
  const done = hasGuessed(st);
  const active = st.pl.filter((p) => p.on);
  const team = coop(st);
  const stage = stageOf(st);
  const myTurn = team && rd.turn === me.id;
  const sent = team && g.sent === rd.gs;
  const last = stage >= GUESS_STEPS.length - 1;
  const playing = playback.status === 'playing' || playback.status === 'loading';
  const lines = done ? [] : hintLines(app.lyr, stage, m?.name, (m?.at || 0) / 1000);
  const steps = GUESS_STEPS.map((sec, i) => `<li class="${done ? '' : i < stage ? 'past' : i === stage ? 'on' : ''}"><b>${sec} sn</b><span>+${GUESS_PTS[i]}</span></li>`).join('');

  let body;
  if (done) {
    const ok = g.done === 'ok';
    const head = g.done ? (ok ? `Bildin! <b class="up">+${GUESS_PTS[g.stage]}</b>` : 'Bu sefer olmadı') : 'Yanıtın alındı';
    body = `
      <div class="answer ${ok ? 'ok' : ''}">
        <h3>${head}</h3>
        <p class="title">${esc(m?.name || '')}</p>
        <p class="artist">${esc(m?.artists || '')}</p>
      </div>
      <div class="dock"><p class="waiting"><span class="pulse"></span>Diğerleri bekleniyor · ${rd.done.filter((id) => P.get(id)?.on).length}/${active.length} oyuncu bitirdi</p></div>`;
  } else {
    body = `
      <button class="snip ${playing ? 'on' : ''}" data-act="replay" aria-label="Kesiti yeniden dinle">
        ${playing ? '<span class="eq"><i></i><i></i><i></i><i></i></span>' : icon('play')}
        <em>${playing ? 'Çalıyor…' : `Tekrar dinle · ${GUESS_STEPS[stage]} sn`}</em>
      </button>
      <div class="lyr ${lines.length ? '' : 'empty'}" data-key="lyr">
        ${lines.length ? lines.map((l) => `<p>${esc(l)}</p>`).join('') : `<span>${app.lyr && !app.lyr.length ? 'Bu şarkının sözleri bulunamadı' : stage ? 'Sözler aranıyor…' : 'Söz ipucu bir sonraki aşamada'}</span>`}
      </div>
      ${
        team && (!myTurn || sent)
          ? ''
          : `<form class="guess" data-submit="guess" data-key="guess${team ? stage : ''}">
        <input data-model="guess" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="send" maxlength="80" placeholder="Şarkının adını yaz" aria-label="Tahminin">
        <button class="btn primary" type="submit">Tahmin et</button>
        ${g.sug?.length ? `<ul class="sug">${g.sug.map((t, i) => `<li><button type="button" data-act="sug" data-i="${i}"><b>${esc(t.name)}</b><span>${esc(t.artists)}</span></button></li>`).join('')}</ul>` : ''}
      </form>`
      }
      <div class="dock">
        ${
          team
            ? myTurn && !sent
              ? `<button class="btn" data-act="giveup">Ben Bunu Bilmiom</button>
                 <p class="note">${last ? 'Son hak: bilinemezse bu şarkıdan puan yok.' : `Bilemezsen ya da ${secs} sn içinde yanıt vermezsen sıra geçer; sıradaki ${GUESS_STEPS[stage + 1]} sn dinler.`}</p>`
              : `<p class="waiting"><span class="pulse"></span>${myTurn ? 'Yanıtın gönderiliyor…' : `Tahmin sırası: ${esc(P.get(rd.turn)?.name || '…')} · tek tahmin hakkı var`}</p>`
            : `<div class="row">${last ? '' : `<button class="btn" data-act="more">Biraz daha · ${GUESS_STEPS[stage + 1]} sn <small>(+${GUESS_PTS[stage + 1]})</small></button>`}<button class="btn" data-act="giveup">Ben Bunu Bilmiom</button></div>`
        }
      </div>`;
  }

  return `
  <main class="play" data-key="guess">
    <div class="play-main g">
      ${audioView(rd, m, !done)}
      <header class="now">
        <div class="kicker"><span>Şarkı ${rd.no}</span><span class="clock ${secs <= 10 ? 'hot' : ''}">${secs} sn</span></div>
        <h2 class="title">${done ? 'Tur bitiyor…' : myTurn ? 'Sıra sende!' : 'Bu şarkı hangisi?'}</h2>
      </header>
      <ol class="steps">${steps}</ol>
      ${body}
    </div>
    ${boardView(st, P)}
  </main>`;
}

// Kapak bulmacası: kapak herkes için aynı hızda netleşir; herkes kendi tahminini yazar.
function coverView(st) {
  const rd = st.rd;
  const g = app.g;
  const P = new Map(st.pl.map((p) => [p.id, p]));
  const m = rd.meta;
  const elapsed = Math.max(0, hnow() - rd.t0);
  const secs = Math.ceil(Math.max(0, rd.t1 - hnow()) / 1000);
  const done = hasGuessed(st);
  const stage = coverStage(st);
  const img = isDemo(rd.id) ? demoCover(rd.id) : safeImg(m?.img);
  // Son adımın ortasında tamamen net; başta kapağı tanınmaz kılacak kadar bulanık.
  const clear = done ? 1 : clamp01(elapsed / (COVER_STEP * 2500));
  const blur = ((1 - clear) ** 1.4 * 36).toFixed(1);
  const jam = Math.max(0, (g.jam || 0) - Date.now());
  const active = st.pl.filter((p) => p.on);
  const steps = COVER_LABELS.map((label, i) => `<li class="${done ? '' : i < stage ? 'past' : i === stage ? 'on' : ''}"><b>${label}</b><span>+${GUESS_PTS[i]}</span></li>`).join('');

  let body;
  if (done) {
    const ok = g.done === 'ok';
    const head = g.done ? (ok ? `Bildin! <b class="up">+${GUESS_PTS[g.stage]}</b>` : 'Bu sefer olmadı') : 'Yanıtın alındı';
    body = `
      <div class="answer ${ok ? 'ok' : ''}">
        <h3>${head}</h3>
        <p class="title">${esc(m?.artists || '')}</p>
        <p class="artist">${esc(m?.name || '')}${m?.album ? ' · ' + esc(m.album) : ''}</p>
      </div>
      <div class="dock"><p class="waiting"><span class="pulse"></span>Diğerleri bekleniyor · ${rd.done.filter((id) => P.get(id)?.on).length}/${active.length} oyuncu bitirdi</p></div>`;
  } else {
    body = `
      <form class="guess ${jam ? 'jammed' : ''}" data-submit="guess" data-key="guess">
        <input data-model="guess" ${jam ? 'readonly' : ''} autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="send" maxlength="80" placeholder="${jam ? `Yanlış! ${Math.ceil(jam / 1000)} sn` : 'Sanatçı, albüm ya da şarkı'}" aria-label="Tahminin">
        <button class="btn primary" type="submit" ${jam ? 'disabled' : ''}>Tahmin et</button>
        ${g.sug?.length ? `<ul class="sug">${g.sug.map((t, i) => `<li><button type="button" data-act="sug" data-i="${i}"><b>${esc(t.name)}</b><span>${esc(t.artists)}</span></button></li>`).join('')}</ul>` : ''}
      </form>
      <div class="dock"><button class="btn" data-act="giveup">Ben Bunu Bilmiom</button></div>`;
  }

  return `
  <main class="play" data-key="guess">
    <div class="play-main g">
      ${audioView(rd, m, true)}
      <header class="now">
        <div class="kicker"><span>Kapak ${rd.no}</span><span class="clock ${secs <= 8 ? 'hot' : ''}">${secs} sn</span></div>
        <h2 class="title">${done ? 'Tur bitiyor…' : 'Bu kapak kimin?'}</h2>
      </header>
      <ol class="steps">${steps}</ol>
      <div class="cover-box" data-key="cover">${img ? `<img src="${esc(img)}" alt="" referrerpolicy="no-referrer" draggable="false" style="filter:blur(${blur}px)">` : '<span>♪</span>'}</div>
      ${body}
    </div>
    ${boardView(st, P)}
  </main>`;
}

function guessRevealView(st) {
  const rd = st.rd;
  const P = new Map(st.pl.map((p) => [p.id, p]));
  const m = rd.meta || meta.get(rd.id) || (isDemo(rd.id) ? demoMeta(rd.id) : null);
  const img = safeImg(m?.img);
  const active = st.pl.filter((p) => p.on);
  const knew = Object.values(rd.res || {}).filter((r) => r[0]).length;
  const art = isDemo(rd.id) && st.set.mode === 'cover' ? demoCover(rd.id) : img;
  const d = rd.dl?.[me.id];
  const owners = (rd.ls || []).map((id) => P.get(id)).filter(Boolean);
  let cta;
  if (!hasContinued(st)) {
    cta = `<button class="btn primary xl" data-act="cont">Devam</button>`;
  } else {
    const waitingFor = active.filter((p) => !rd.cont.includes(p.id)).map((p) => esc(p.name));
    cta = `<p class="waiting"><span class="pulse"></span>Herkesin “Devam” demesi bekleniyor · ${active.length - waitingFor.length}/${active.length}</p>
      ${waitingFor.length ? `<p class="note">Bekleniyor: ${waitingFor.join(', ')}</p>` : ''}`;
  }
  return `
  <main class="play" data-key="guess">
    <div class="play-main g">
      ${audioView(rd, m)}
      <header class="now">
        <div class="kicker"><span>Şarkı ${rd.no}</span></div>
        <div class="art">${art ? `<img src="${esc(art)}" alt="" referrerpolicy="no-referrer">` : '<span>♪</span>'}</div>
        <h2 class="title">${esc(m?.name || 'Şarkı')}</h2>
        <p class="artist">${esc(m?.artists || '')}${st.set.mode === 'cover' && m?.album ? ' · ' + esc(m.album) : ''}</p>
        ${saveButton(rd)}
      </header>
      <div class="ask">
        <h3>${rd.td != null && knew ? `${esc(P.get(rd.first)?.name || 'Takım')} bildi!` : knew ? `${knew} kişi bildi` : 'Kimse bilemedi'}</h3>
        <p>${rd.td != null ? `Takım bu turdan <b class="${rd.td ? 'up' : ''}">${signed(rd.td)} puan</b> aldı` : d == null ? 'Bu turda yanıt vermedin' : `Bu turdan <b class="${d > 0 ? 'up' : ''}">${signed(d)} puan</b> aldın`}</p>
        ${owners.length ? `<p>Listesinde olanlar: ${owners.map((p) => `<b>${esc(p.name)}</b>`).join(', ')}</p>` : ''}
      </div>
      ${reactBar()}
      <div class="dock">${cta}</div>
    </div>
    ${boardView(st, P)}
  </main>`;
}

// Altıpatlar: namlu sağa bakar. Renkler CSS'ten gelir (metal, koyu metal, ahşap kabza).
const GUN = `<svg class="gun" viewBox="0 0 164 96" aria-hidden="true">
  <path class="g-wood" d="M34 44c-9 12-17 28-20 42 8 7 22 8 30 3 2-14 7-27 13-38l-7-11z"/>
  <path class="g-shine" d="M30 54c-5 8-9 18-11 27"/>
  <path class="g-dark" d="M44 14l-9-11 7-3 9 12z"/>
  <path class="g-metal" d="M46 12h36v8h70a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4H84v12h-6c-2 7-8 10-15 10H44c-8-8-8-32 2-46z"/>
  <rect class="g-dark" x="84" y="38" width="50" height="7" rx="3.5"/>
  <path class="g-dark" d="M148 20l3-8h4v8z"/>
  <rect class="g-drum" x="50" y="16" width="30" height="30" rx="7"/>
  <path class="g-line" d="M50 26h30M50 36h30"/>
  <path class="g-guard" d="M56 56c5 18 22 16 26-2"/>
  <path class="g-line" d="M66 54c1 6 3 9 6 10"/>
  <circle class="g-dark" cx="42" cy="50" r="2.6"/>
</svg>`;

// Oyun sonu sahnesi için: taç, surat (mutlu / üzgün) ve sopaya bağlı beyaz don.
const CROWN = `<svg class="crown" viewBox="0 0 120 78" aria-hidden="true">
  <path class="c-gold" d="M12 62 6 20l26 20 28-34 28 34 26-20-6 42z"/>
  <path class="c-shade" d="M12 62h96l-2 10H14z"/>
  <path class="c-lite" d="M18 30l14 11 26-31 4 5-26 33-17-13z"/>
  <circle class="c-gold" cx="6" cy="18" r="6"/><circle class="c-gold" cx="60" cy="6" r="6"/><circle class="c-gold" cx="114" cy="18" r="6"/>
  <circle class="c-red" cx="60" cy="50" r="6"/><circle class="c-blue" cx="34" cy="54" r="4.5"/><circle class="c-blue" cx="86" cy="54" r="4.5"/>
</svg>`;

// Profil: oyuncunun baş harfi yerinde durur; üstüne çizgiyle kaş, altına ağız eklenir.
const face = (p, mood) => `<svg class="dface ${mood}" viewBox="0 0 100 100" style="--h:${p.hue}" role="img" aria-label="${esc(p.name)}">
  <circle class="f-skin" cx="50" cy="50" r="46"/>
  <text class="f-letter" x="50" y="53" text-anchor="middle" dominant-baseline="central">${esc(initial(p.name))}</text>
  ${
    mood === 'happy'
      ? '<path class="f-line" d="M24 29q10-9 20 0M56 29q10-9 20 0M33 76q17 13 34 0"/>'
      : '<path class="f-line" d="M23 33l20-9M77 33l-20-9M34 84q16-12 32 0"/>'
  }
</svg>`;

const pantsFlag = (stained) => `<svg class="pflag" viewBox="0 0 150 172" aria-hidden="true">
  <path class="p-stick" d="M18 168 34 8"/>
  <g class="p-wave">
    <path class="p-cloth" d="M36 14h102l-6 32c-17 2-28 14-32 38H74c-4-24-15-36-32-38z"/>
    ${stained ? '<path class="p-stain" d="M70 68c1-11 12-17 22-12 9 5 9 19-1 25-9 5-22-1-21-13z"/><path class="p-stain deep" d="M78 70c1-6 7-8 11-5 5 4 3 11-3 13-5 1-9-3-8-8z"/>' : ''}
    <path class="p-band" d="M36 14h102l-2.4 13H38.4z"/>
    <path class="p-seam" d="M80 30c3 18 3 36 0 54M94 30c-3 18-3 36 0 54M46 52c13 3 22 13 26 30M128 52c-13 3-22 13-26 30"/>
    <path class="p-tag" d="M82 14h10v8H82z"/>
    <path class="p-tie" d="M30 12q10 4 6 12M32 40q10 3 8 12"/>
  </g>
</svg>`;

const HAT = '<svg class="hat" viewBox="0 0 100 46" aria-hidden="true"><path d="M3 37c22 9 72 9 94 0-9-5-19-7-25-7l-6-23c-8-6-24-6-32 0l-6 23c-6 0-16 2-25 7z"/></svg>';

// Düello: iki oyuncu karşı karşıya. Bahis → düello → sonuç aynı sahnede oynanır; oynatıcı
// "şarkıyı bil" ekranındaki gibi hep ilk sırada durur ki ekran değişirken yeniden yüklenmesin.
function duelView(st) {
  const rd = st.rd;
  const phase = st.phase;
  const reveal = phase === 'reveal';
  const P = new Map(st.pl.map((p) => [p.id, p]));
  const m = rd.meta || meta.get(rd.id) || (isDemo(rd.id) ? demoMeta(rd.id) : null);
  const mySide = rd.duel.indexOf(me.id);
  const myBet = app.g.bet ?? rd.bets[me.id];
  const win = reveal ? rd.win : null;
  const secs = Math.ceil(Math.max(0, (phase === 'bet' ? rd.bt1 : rd.t1) - hnow()) / 1000);
  const jam = Math.max(0, (app.g.jam || 0) - Date.now());
  const canBet = phase === 'bet' && mySide < 0;
  const winner = win >= 0 ? P.get(rd.duel[win]) : null;

  const coin = (id, cls = '') => {
    const p = P.get(id);
    return p ? `<i class="coin ${cls} ${id === me.id ? 'mine' : ''}" data-key="coin-${id}" title="${esc(p.name)}">${esc(initial(p.name))}</i>` : '';
  };
  const gunman = (side) => {
    const p = P.get(rd.duel[side]);
    if (!p) return `<div class="gunman s${side}"></div>`;
    const state = !reveal ? '' : win < 0 ? 'draw' : win === side ? 'won' : 'hit';
    const bettors = Object.keys(rd.bets).filter((id) => rd.bets[id] === side);
    // Kaybedene oynanan paralar sonuçta kazananın yanına kayar.
    let coins = bettors.map((id) => coin(id, reveal && win === side ? 'paid' : '')).join('');
    if (reveal && win >= 0) coins = win === side ? coins + Object.keys(rd.bets).filter((id) => rd.bets[id] !== side).map((id) => coin(id, 'slid')).join('') : '';
    const delta = reveal ? rd.dl?.[p.id] : null;
    const miss = !reveal && rd.miss[p.id];
    return `
      <div class="gunman s${side} ${state} ${p.id === me.id ? 'me' : ''} ${canBet && myBet === side ? 'picked' : ''}" style="--h:${p.hue}" ${canBet ? `data-act="bet" data-k="${side}" role="button" tabindex="0"` : ''}>
        <div class="stance">
          <div class="figure">${HAT}<span class="face">${esc(initial(p.name))}</span>${state === 'hit' ? '<i class="boom"></i>' : ''}</div>
          <div class="arm">${GUN}<i class="flash"></i>${miss ? `<i class="jam" data-key="jam-${miss}">tık!</i>` : ''}</div>
        </div>
        <b class="gname">${esc(p.name)}${p.id === me.id ? '<em>sen</em>' : ''}</b>
        <span class="gscore">${p.sc} puan${delta ? ` <b class="up">${signed(delta)}</b>` : ''}</span>
        <div class="coins">${coins}</div>
      </div>`;
  };

  let mid;
  if (phase === 'bet') mid = `<b class="vs">VS</b><span class="count">${secs}</span>`;
  else if (phase === 'duel') mid = `<b class="call" data-key="call">ÇEK!</b><span class="count ${secs <= 5 ? 'hot' : ''}">${secs}</span>`;
  else mid = win >= 0 ? `<i class="bullet b${win}"></i>` : '<b class="vs">—</b>';

  let title;
  let controls;
  if (phase === 'bet') {
    title = mySide >= 0 ? 'Hazır ol…' : 'Bahisler!';
    controls =
      mySide >= 0
        ? `<p class="waiting"><span class="pulse"></span>Şarkı birazdan çalacak · kimin dinlediğini ilk bilen kazanır</p>`
        : `<div class="ask"><h3>Kim kazanır?</h3><p>${myBet == null ? 'Paranı koymak için bir düellocuya dokun' : `Paran <b>${esc(P.get(rd.duel[myBet])?.name || '')}</b> üzerinde · değiştirebilirsin`}</p></div>`;
  } else if (phase === 'duel') {
    title = mySide >= 0 ? 'Çek silahını!' : 'Düello başladı';
    if (mySide < 0) {
      controls = `<p class="waiting"><span class="pulse"></span>${myBet == null ? 'Bahis oynamadın · izliyorsun' : `Paran ${esc(P.get(rd.duel[myBet])?.name || '')} üzerinde`}</p>`;
    } else {
      const locked = jam || app.g.fired;
      controls = `
      <div class="ask"><h3>Bu şarkıyı kim dinliyor?</h3><p>${jam ? `<b class="down">Tutukluk! ${Math.ceil(jam / 1000)} sn</b>` : app.g.fired ? 'Ateş ettin…' : 'İlk doğru basan kazanır · yanlış basarsan silah tutuklar'}</p></div>
      <div class="targets ${locked ? 'locked' : ''}" data-key="targets">
        ${st.pl.map((p) => `<button data-act="shot" data-id="${p.id}" style="--h:${p.hue}" class="${app.g.fired === p.id ? 'on' : ''}" ${locked ? 'disabled' : ''}>${av(p)}<span>${p.id === me.id ? 'Ben' : esc(p.name)}</span></button>`).join('')}
      </div>`;
    }
  } else {
    title = win < 0 ? 'Kimse çekemedi' : `${esc(winner?.name || '')} vurdu!`;
    const mine = rd.dl?.[me.id];
    const owners = (rd.ls || []).map((id) => P.get(id)).filter(Boolean);
    const lost = mySide < 0 && myBet != null && win >= 0 && myBet !== win;
    controls = `
      <div class="answer ${win >= 0 ? 'ok' : ''}">
        <p class="owner">${owners.length ? `Bu şarkıyı ${owners.map((p) => `${av(p)}<b>${esc(p.id === me.id ? 'sen' : p.name)}</b>`).join(' ve ')} ${owners.length === 1 && owners[0].id === me.id ? 'dinliyorsun' : 'dinliyor'}` : ''}</p>
        ${rd.x2 ? '<p class="x2">Azınlık kazandı · ödüller 2 katı</p>' : ''}
        <h3>${win < 0 ? 'Berabere · puan yok' : mine ? `Bu turdan <b class="up">${signed(mine)} puan</b> aldın` : lost ? 'Paran karşı tarafa gitti' : 'Bu turdan puan almadın'}</h3>
        ${saveButton(rd)}
      </div>
      ${reactBar()}
      <div class="dock">${contDock(st, P)}</div>`;
  }

  return `
  <main class="play" data-key="duel">
    <div class="play-main g">
      ${audioView(rd, m)}
      <header class="now">
        <div class="kicker"><span>Düello ${rd.no}</span></div>
        <h2 class="title">${title}</h2>
        <p class="artist">${phase === 'bet' ? 'Şarkı düello başlayınca çalacak' : `♪ ${esc(m?.name || 'Şarkı çalıyor…')}${m?.artists ? ' · ' + esc(m.artists) : ''}`}</p>
      </header>
      <div class="arena ${phase}" data-key="arena">
        ${gunman(0)}
        <div class="mid">${mid}</div>
        ${gunman(1)}
      </div>
      ${controls}
    </div>
    ${boardView(st, P)}
  </main>`;
}

function contDock(st, P) {
  const rd = st.rd;
  const active = st.pl.filter((p) => p.on);
  if (!hasContinued(st)) return `<button class="btn primary xl" data-act="cont">Devam</button>`;
  const waitingFor = active.filter((p) => !rd.cont.includes(p.id)).map((p) => esc(p.name));
  return `<p class="waiting"><span class="pulse"></span>Herkesin “Devam” demesi bekleniyor · ${active.length - waitingFor.length}/${active.length}</p>
      ${waitingFor.length ? `<p class="note">Bekleniyor: ${waitingFor.join(', ')}</p>` : ''}`;
}

// Düellonun final sahnesi: kazanan taçla yukarıda, diğerleri üzgün suratla beyaz donu sallar.
function duelFinale(st, winners) {
  const ids = new Set(winners.map((p) => p.id));
  const losers = st.pl
    .filter((p) => !ids.has(p.id))
    .sort((a, b) => b.sc - a.sc || a.name.localeCompare(b.name, 'tr'));
  // Donu lekeli talihsiz: herkesin ekranında aynı kişi çıksın diye oyunun kimliğinden seçilir.
  const unlucky = losers.length ? losers[cyrb53(st.inst + [...ids].join()) % losers.length].id : null;
  return `
    <div class="finale" data-key="finale">
      <div class="champs">
        ${winners
          .map(
            (p) => `
          <div class="champ" data-key="champ-${p.id}">
            <div class="rays" aria-hidden="true"></div>
            ${CROWN}
            ${face(p, 'happy')}
            <b>${esc(p.name)}</b>
            <span>${p.sc} puan</span>
          </div>`
          )
          .join('')}
      </div>
      <div class="podium" aria-hidden="true"><i>1</i></div>
      ${
        losers.length
          ? `<div class="losers">${losers
              .map(
                (p, i) => `
          <div class="loser" data-key="loser-${p.id}" style="--d:${(i % 5) * 0.12}s">
            <div class="pose">${pantsFlag(p.id === unlucky)}${face(p, 'sad')}</div>
            <b>${esc(p.name)}</b>
            <span>${p.sc} puan</span>
          </div>`
              )
              .join('')}</div>`
          : ''
      }
    </div>`;
}

function wonView(st) {
  const P = new Map(st.pl.map((p) => [p.id, p]));
  const winners = st.win.ids.map((id) => P.get(id)).filter(Boolean);
  const team = st.win.team;
  const names = winners.map((p) => esc(p.name)).join(' ve ') || 'Kimse';
  const hostP = P.get(st.host);
  // Oyun sonu özeti: bana özel iki kart.
  const sum = st.win.sum?.[me.id] || {};
  const card = (label, p, detail) => (p ? `<div><span>${label}</span><b>${av(p)}${esc(p.name)}</b><em>${detail}</em></div>` : '');
  const recap =
    card('Müzik ikizin', P.get(sum.tw?.[0]), `${sum.tw?.[1]} ortak şarkı · şarkılarının %${sum.tw?.[2]}'i`) +
    card('Seni en iyi tanıyan', P.get(sum.kn?.[0]), `${sum.kn?.[1]} doğru tahmin`);
  const duel = st.set.mode === 'duel' && winners.length > 0;
  return `
  <main class="won ${duel ? 'duel-end' : ''}" data-key="won">
    ${duel ? duelFinale(st, winners) : `<div class="trophy" style="--h:${winners[0]?.hue ?? 50}">${winners[0] ? esc(initial(winners[0].name)) : '?'}</div>`}
    <p class="kicker">${duel ? 'Düello bitti' : 'Oyun bitti'}</p>
    <h2>${team ? (st.win.out ? 'Şarkılar bitti' : 'Takım başardı!') : `${names} kazandı!`}</h2>
    ${team ? `<p class="note"><b>${team.pts} puan</b> · ${team.songs} şarkıda</p>` : ''}
    ${st.win.out && !team ? '<p class="note">Şarkılar tükendi; en yüksek puan kazandı.</p>' : ''}
    ${recap ? `<div class="recap">${recap}</div>` : ''}
    ${boardView(st, P)}
    ${reactBar()}
    <div class="dock">
      ${
        isHost()
          ? `<button class="btn primary xl" data-act="again">Tekrar oyna</button><button class="btn" data-act="lobby">Lobiye dön</button>`
          : `<p class="waiting"><span class="pulse"></span>${esc(hostP?.name || 'Host')} yeni oyunu başlatabilir</p>`
      }
    </div>
  </main>`;
}

function countdownView(st) {
  const n = Math.max(1, Math.ceil((st.cd - hnow()) / 1000));
  return `<div class="countdown" data-key="countdown"><span>Başlıyor</span><b data-key="n${n}">${n}</b></div>`;
}

function roomView() {
  const st = app.st;
  if (!st) return connectingView();
  let body;
  if (st.phase === 'lobby') body = lobbyView(st);
  else if (st.phase === 'countdown') body = lobbyView(st) + countdownView(st);
  else if (st.phase === 'won') body = wonView(st);
  else if (st.rd?.duel) body = duelView(st);
  else if (st.phase === 'guess') body = st.set.mode === 'cover' ? coverView(st) : guessView(st);
  else if (st.phase === 'reveal' && st.rd.res) body = guessRevealView(st);
  else body = playView(st);
  return barView() + body;
}

// ---------- pencereler ----------

// Sitedeki "Spotify cihazına bağlan" adımı: oyuncu Spotify'ın açık olduğu cihazı seçer,
// şarkılar orada kendiliğinden çalar. Cihazı olmayan için sekmede çalma ve sessiz seçenek de var.
function devicePicker() {
  const list = spotify.authed() ? app.devices || [] : [];
  const mode = playback.mode;
  const row = (on, attrs, title, tag) => `<button class="${on ? 'on' : ''}" ${attrs} aria-pressed="${on}"><span>${title}</span><em>${tag}</em></button>`;
  let hint = 'Spotify ile bağlananlar şarkıyı kendi cihazında da çalabilir.';
  if (spotify.authed()) {
    hint = list.length
      ? 'Seçtiğin cihazda şarkılar kendiliğinden çalar (Spotify Premium gerekir). Orada açılmazsa şarkı bu sekmede çalar.'
      : 'Cihaz görünmüyor mu? Spotify uygulamasını aç, herhangi bir şarkıyı birkaç saniye çal ve listeyi yenile.';
  }
  return `
    <div class="devs">
      ${list.map((d) => row(mode === 'device' && playback.device === d.id, `data-act="dev-pick" data-id="${esc(d.id)}"`, esc(d.name), d.is_active ? 'şu an açık' : 'uykuda')).join('')}
      ${app.devBusy && !list.length ? '<div class="loading"><span class="spinner"></span><div><b>Spotify cihazların aranıyor…</b></div></div>' : ''}
      ${row(mode === 'web', 'data-act="audio-mode" data-v="web"', 'Bu sekmede çal', spotify.authed() && spotify.canStream() ? 'ses ayarlı · Premium' : 'cihaz gerekmez')}
      ${row(mode === 'none', 'data-act="audio-mode" data-v="none"', 'Ses yok', 'sesi başkası açıyorsa')}
    </div>
    ${spotify.authed() ? `<div class="mini-actions"><button class="link" data-act="dev-refresh">${icon('refresh')} Cihazları yenile</button></div>` : ''}
    <p class="note">${hint}</p>
    ${spotify.authed() && !spotify.canStream() ? `<p class="note">Bu sekmede ses düzeyini ayarlamak ve şarkıların hemen değişmesi için Spotify'a bir kez yeniden bağlanman gerekiyor${app.s ? ' (odadan çıkınca).' : `. <button class="link" data-act="connect">Yeniden bağlan</button>`}</p>` : ''}`;
}

function audioModal() {
  return `
    <h3>Şarkı nerede çalsın?</h3>
    ${devicePicker()}
    <button class="btn primary" data-act="close">Tamam</button>`;
}

// Host'a gelen giriş istekleri: oyuncunun yazdığı Spotify e-postası, panele eklenmek üzere.
function asksModal() {
  const rows = app.asks
    .map(
      (a, i) => `
      <li data-key="ask-${esc(a.mail)}">
        <div><b>${esc(a.name)}</b><span>${esc(a.mail)}</span></div>
        <button class="btn sm" data-act="ask-copy" data-i="${i}">${icon('copy')} Kopyala</button>
        <button class="icon-btn sm" data-act="ask-del" data-i="${i}" aria-label="İsteği sil">${icon('x')}</button>
      </li>`
    )
    .join('');
  return `
    <h3>Giriş isteyenler</h3>
    <p class="note">Bu e-postaları Spotify panelinde uygulamanın “User Management” bölümüne ekle. Ekleyince oyuncu kendi ekranında “Eklendim, tekrar dene”ye bassın.</p>
    <ul class="asks">${rows || '<li><span>Bekleyen istek yok.</span></li>'}</ul>
    <div class="row">
      <a class="btn" href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">Spotify panelini aç</a>
      <button class="btn primary" data-act="close">Tamam</button>
    </div>`;
}

function setupModal() {
  return `
    <h3>Kurulum (yalnızca siteyi yayınlayan kişi)</h3>
    <ol class="setup">
      <li><b>developer.spotify.com/dashboard</b> adresinde bir uygulama oluştur (hesabın Premium olmalı). API olarak “Web API” seç.</li>
      <li>“Redirect URIs” alanına tam olarak şu adresi ekle:
        <button class="uri" data-act="copy-uri"><span>${esc(spotify.redirectUri())}</span>${icon('copy')}</button>
      </li>
      <li>Uygulamanın <b>Client ID</b> değerini <span class="mono">config.js</span> içindeki <span class="mono">spotifyClientIds</span> listesine yaz.</li>
      <li>“User Management” bölümünden oynayacak arkadaşlarının Spotify e-postalarını ekle (uygulama başına 5 hesap).</li>
    </ol>
    <p class="note">Oyunculardan hiçbir kod istenmez; onlar yalnızca Spotify hesabıyla bağlanır ve Spotify'ın açık olduğu cihazı seçer.</p>
    <button class="btn primary" data-act="close">Tamam</button>`;
}

function howModal() {
  return `
    <h3>Nasıl oynanır?</h3>
    <ol class="setup">
      <li>Biri oda kurar, linki ya da 6 harfli kodu paylaşır.</li>
      <li>Herkes Spotify hesabıyla bağlanır; sık dinlenenler, kendi listeleri, beğendiği şarkılar ve kayıtlı albümlerdeki şarkılar oyuna girer.</li>
      <li>Rastgele bir şarkı çalar. O şarkıyı dinlediğini düşündüğün herkesi seçip oy verirsin (kendin dahil).</li>
      <li>Her doğru isim +3, her yanlış isim −1 puan. Süre biterse seçtiklerin otomatik gönderilir.</li>
      <li>Herkes “Devam” deyince sıradaki şarkı başlar. Hedef puana ilk ulaşan kazanır.</li>
    </ol>
    <p class="note"><b>Şarkıyı bil modu:</b> host oda ayarlarından açar. Şarkının ilk 5 saniyesi çalar, adını yazarsın; bilemezsen 10, sonra 20 saniye dinlersin. Erken bilen daha çok puan alır (5 / 3 / 2). Bireysel ya da tek takım olarak sırayla oynanır.</p>
    <p class="note"><b>Kapak bulmacası:</b> albüm kapağı bulanık başlar, adım adım netleşir; ses çalmaz. Sanatçıyı, albümü ya da şarkıyı ne kadar bulanıkken bilirsen o kadar puan alırsın (5 / 3 / 2).</p>
    <p class="note"><b>Düello modu:</b> yalnızca bir kişinin dinlediği bir şarkı çalar; karşı karşıya gelen iki oyuncudan o kişiyi ilk bilen kazanır (+3). Diğerleri bahis oynar: kazanana oynayan +2 alır, kaybedene oynanan paralar kazananın olur. Az bahis alan taraf kazanırsa ödüller iki katıdır.</p>
    <p class="note">Aynı şarkının single ve albüm sürümleri tek şarkı sayılır: birinde single, diğerinde albüm hâli olsa da ikisi de dinleyen olarak çıkar.</p>
    <button class="btn primary" data-act="close">Anladım</button>`;
}

function modalView() {
  const m = app.modal;
  if (!m) return '';
  let body = '';
  if (m.name === 'audio') body = audioModal();
  else if (m.name === 'setup') body = setupModal();
  else if (m.name === 'how') body = howModal();
  else if (m.name === 'asks') body = asksModal();
  else if (m.name === 'leave') {
    body = `<h3>${isHost() ? 'Odayı kapat?' : 'Odadan ayrıl?'}</h3>
      <p class="note">${isHost() ? 'Host sensin: ayrılırsan oda herkes için kapanır.' : 'Aynı isimle tekrar girersen puanın korunur.'}</p>
      <div class="row"><button class="btn" data-act="close">Vazgeç</button><button class="btn danger" data-act="leave-yes">${isHost() ? 'Odayı kapat' : 'Ayrıl'}</button></div>`;
  } else if (m.name === 'kick') {
    const p = app.st?.pl.find((x) => x.id === m.id);
    body = `<h3>${esc(p?.name || 'Oyuncu')} odadan çıkarılsın mı?</h3>
      <div class="row"><button class="btn" data-act="close">Vazgeç</button><button class="btn danger" data-act="kick-yes">Çıkar</button></div>`;
  }
  return `<div class="modal" data-key="modal" data-act="close" data-self="1"><div class="sheet" role="dialog" aria-modal="true">${body}</div></div>`;
}

function bannerView() {
  if (!app.s || !app.st) return '';
  let text = '';
  if (!app.s.chan.online) text = 'Bağlantı koptu — yeniden bağlanılıyor…';
  else if (!isHost() && !app.s.core.hostAlive) text = 'Host’a ulaşılamıyor — bekleniyor…';
  return text ? `<div class="banner" data-key="banner"><span class="spinner"></span>${text}</div>` : '';
}

function view() {
  const main = app.s ? roomView() : app.view === 'prep' && app.intent ? prepView() : homeView();
  const toasts = `<div class="toasts" data-key="toasts" aria-live="polite">${app.toasts.map((t) => `<div class="toast ${t.kind}" data-key="t-${t.id}">${esc(t.text)}</div>`).join('')}</div>`;
  return main + bannerView() + modalView() + toasts;
}

// ---------- çizim ----------

// Yeni HTML'i mevcut DOM'a işler: değişmeyen düğümler yerinde kalır, böylece yazı kutuları,
// gömülü oynatıcı ve geçiş animasyonları her çizimde sıfırlanmaz.
function syncKids(parent, next) {
  const keyed = new Map();
  for (const el of parent.children) if (el.dataset.key) keyed.set(el.dataset.key, el);
  const want = [...next.childNodes];
  want.forEach((n, i) => {
    const cur = parent.childNodes[i] || null;
    let hit = null;
    if (n.nodeType === 1 && n.dataset.key) hit = keyed.get(n.dataset.key) || null;
    else if (cur && cur.nodeType === n.nodeType && !(cur.nodeType === 1 && cur.dataset.key)) hit = cur;
    if (hit && n.nodeType === 1 && hit.tagName !== n.tagName) hit = null;
    if (!hit) {
      parent.insertBefore(n, cur);
      return;
    }
    if (hit !== cur) parent.insertBefore(hit, cur);
    patch(hit, n);
  });
  while (parent.childNodes.length > want.length) parent.lastChild.remove();
}

function patch(el, n) {
  if (el.nodeType !== 1) {
    if (el.nodeValue !== n.nodeValue) el.nodeValue = n.nodeValue;
    return;
  }
  for (const { name } of [...el.attributes]) if (!n.hasAttribute(name)) el.removeAttribute(name);
  for (const { name, value } of [...n.attributes]) if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  if (!el.hasAttribute('data-keep')) syncKids(el, n);
}

let queued = false;

// Çizim bir sonraki karede yapılır; ama tarayıcı kare vermezse (arka plandaki ya da
// örtülmüş sekme) en geç 50 ms sonra yine de çizilir. Böylece gömülü oynatıcının yeri
// hazır olur ve şarkı sekme görünmezken de başlar.
function update() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(flush);
  setTimeout(flush, 50);
}

function flush() {
  if (queued) render();
}

function render() {
  queued = false;
  const tpl = document.createElement('template');
  tpl.innerHTML = view();
  syncKids($('#app'), tpl.content);
  document.body.dataset.phase = app.s ? app.st?.phase || 'connecting' : app.view;
}

let confettiFor = null;

function confetti() {
  const key = app.st?.inst + ':' + app.st?.rd?.n + ':' + app.st?.win?.ids.join();
  if (confettiFor === key || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  confettiFor = key;
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const w = (canvas.width = innerWidth);
  const h = (canvas.height = innerHeight);
  const bits = Array.from({ length: 140 }, () => ({
    x: Math.random() * w,
    y: -20 - Math.random() * h * 0.6,
    vx: (Math.random() - 0.5) * 3,
    vy: 2 + Math.random() * 4,
    size: 5 + Math.random() * 7,
    hue: Math.random() * 360,
    spin: Math.random() * Math.PI,
    vs: (Math.random() - 0.5) * 0.3,
  }));
  const t0 = performance.now();
  const frame = (t) => {
    ctx.clearRect(0, 0, w, h);
    for (const b of bits) {
      b.x += b.vx;
      b.y += b.vy;
      b.spin += b.vs;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.spin);
      ctx.fillStyle = `hsl(${b.hue} 90% 62%)`;
      ctx.fillRect(-b.size / 2, -b.size / 4, b.size, b.size / 2);
      ctx.restore();
    }
    if (t - t0 < 5000) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}

// ---------- olaylar ----------

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  if (el.dataset.self && e.target !== el) return;
  const fn = actions[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  fn(el.dataset, el);
});

document.addEventListener('input', (e) => {
  const fn = models[e.target.dataset?.model];
  if (fn) fn(e.target.value, e.target);
});

document.addEventListener('submit', (e) => {
  e.preventDefault();
  actions[e.target.dataset.submit]?.({});
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && app.modal) return actions.close();
  const el = e.target.closest?.('[data-act][role="button"]');
  if (el && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    actions[el.dataset.act]?.(el.dataset, el);
  }
});

// İnternet geri geldiğinde ya da sekme öne alındığında susmuş şarkıyı yeniden başlat.
window.addEventListener('online', () => setTimeout(() => playback.revive(), 1500));

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !app.s) return;
  playback.revive();
  app.s.chan.nudge();
  app.s.core.poke?.();
  if (app.st?.phase && app.st.phase !== 'lobby') keepAwake();
});

window.addEventListener('hashchange', () => {
  if (app.s) return;
  const code = cleanCode(location.hash.slice(1));
  if (code.length === CODE_LEN) openPrep({ kind: 'join', code });
});

onTick((now) => {
  const st = app.st;
  flush();
  if (app.toasts.length && app.toasts[0].until < now) {
    app.toasts = app.toasts.filter((t) => t.until >= now);
    update();
  }
  if (!app.s) return;
  if (!st) return update();
  if (st.phase === 'vote' && !hasVoted(st) && hnow() >= st.rd.t1) submitVote(true);
  if (st.phase === 'guess' && !coop(st) && !hasGuessed(st) && hnow() >= st.rd.t1) finishGuess(false);
  if (['vote', 'guess', 'bet', 'duel', 'countdown'].includes(st.phase)) update();
});

// ---------- açılış ----------

async function boot() {
  const back = await spotify.handleCallback();
  const room = ss.get('room');
  if (back) {
    if (back.resume?.intent) app.intent = back.resume.intent;
    if (back.resume?.name) setName(back.resume.name);
    app.source = 'spotify';
    app.view = app.intent ? 'prep' : 'home';
    if (back.ok) {
      // Odaya kendiliğinden girme: oyuncu önce Spotify'ın açık olduğu cihazı seçsin.
      loadSpotify();
    } else {
      toast(back.error === 'access_denied' ? 'Spotify izni verilmedi' : 'Spotify bağlantısı kurulamadı');
    }
  } else if (room?.code) {
    // Sayfa yenilendi: aynı odaya, aynı kimlikle geri dön.
    const saved = ss.get('lib');
    setLib(saved?.mode || 'none', saved?.tracks || []);
    if (room.host) startHost(room.code, ss.get('host'));
    else startClient(room.code);
  } else {
    const code = cleanCode(location.hash.slice(1));
    if (code.length === CODE_LEN) return openPrep({ kind: 'join', code });
  }
  update();
  focusName();
}

boot();
