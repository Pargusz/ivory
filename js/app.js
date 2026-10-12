// Arayüz: ekranlar, etkileşimler ve oturumun (host ya da oyuncu) bağlanması.

import { $, esc, uid, makeCode, cleanCode, cleanName, ls, ss, onTick, copyText, cyrb53, CODE_LEN } from './util.js';
import * as spotify from './spotify.js';
import { Channel } from './net.js';
import { HostGame, WIN_OPTIONS, TIME_OPTIONS } from './host.js';
import { ClientSession } from './client.js';
import { Playback } from './audio.js';
import { FL, PL, AL, SOURCES, encodeLib } from './lib.js';
import { demoLibrary, demoMeta, isDemo } from './demo.js';

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
};
const icon = (name) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

const initial = (name) => ([...String(name || '?')][0] || '?').toLocaleUpperCase('tr');
const av = (p, cls = '') => `<span class="av ${cls}" style="--h:${p.hue}">${esc(initial(p.name))}</span>`;
const signed = (n) => (n > 0 ? '+' + n : n < 0 ? '−' + Math.abs(n) : '0');
const clamp01 = (x) => Math.max(0, Math.min(1, x));
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

async function resolveMeta(id) {
  if (meta.has(id)) return meta.get(id);
  if (isDemo(id)) return demoMeta(id);
  if (spotify.authed()) {
    try {
      return await spotify.track(id);
    } catch {}
  }
  try {
    return await spotify.publicMeta(id);
  } catch {
    return null;
  }
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
  resetRound(0);
  ss.set('room', { code: session.code, host: session.host });
  history.replaceState(null, '', '#' + session.code);
  session.chan.open().then(update);
  update();
}

function startHost(code, saved) {
  let core;
  const chan = new Channel({ code, id: me.id, host: true, brokers: CFG.brokers, onMessage: (m) => core.handle(m), onChange: update });
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
}

// Host'tan (ya da kendi motorumuzdan) gelen her yeni durumda çalışır.
function applyState(st) {
  app.st = st;
  const rd = st.rd;
  if (rd && rd.n !== app.round) resetRound(rd.n);
  if (rd && (st.phase === 'vote' || st.phase === 'reveal')) {
    if (app.playedRound !== rd.n) {
      app.playedRound = rd.n;
      playback.play({ id: rd.id, pos: rd.pos });
    }
  } else if (app.playedRound) {
    app.playedRound = 0;
    playback.stop();
  }
  if (st.ev && st.ev.id !== app.seenEv) {
    app.seenEv = st.ev.id;
    if (st.ev.k === 'sv') toast(`${st.ev.who} bu şarkıyı listesine ekledi`, 'good');
  }
  if (st.phase !== 'lobby') keepAwake();
  if (st.phase === 'won') requestAnimationFrame(() => confetti());
  update();
}

const hasVoted = (st) => app.voteSent === st.rd.n || st.rd.voted.includes(me.id);
const hasContinued = (st) => app.contSent === st.rd.n || st.rd.cont.includes(me.id);

function sendToCore(msg) {
  if (isHost()) app.s.core.handle({ ...msg, f: me.id });
  else if (msg.t === 'v') app.s.core.vote(msg.r, msg.b);
  else if (msg.t === 'c') app.s.core.cont(msg.r);
  else if (msg.t === 'sv') app.s.core.saved();
}

function submitVote(force) {
  const st = app.st;
  if (!st?.rd || st.phase !== 'vote' || hasVoted(st)) return;
  const known = new Set(st.pl.map((p) => p.id));
  const ballot = [...app.ballot].filter((id) => known.has(id));
  if (!ballot.length && !force) return toast('Önce bir ya da birkaç oyuncu seç');
  app.voteSent = st.rd.n;
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
    app.devices = (await spotify.devices()).filter((d) => d.id !== playback.localId);
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
    if (k === 'src') app.s.core.setSettings({ src: set.src ^ Number(v) });
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
    app.contSent = st.rd.n;
    sendToCore({ t: 'c', r: st.rd.n });
    update();
  },
  again: () => actions.start(),
  lobby: () => app.s.core.toLobby(),
  save: async () => {
    const rd = app.st?.rd;
    if (!rd || app.saving || app.savedRound === rd.n) return;
    app.saving = true;
    update();
    try {
      const list = await spotify.saveTrack(rd.id);
      app.savedRound = rd.n;
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
  return `
    <div class="set-row">
      <span>Hangi şarkılar kullanılsın?</span>
      <div class="seg multi">${SOURCES.map(
        (s) => `<button class="${set.src & s.bit ? 'on' : ''}" ${host ? `data-act="set" data-k="src" data-v="${s.bit}"` : 'disabled'} aria-pressed="${!!(set.src & s.bit)}">${s.label}</button>`
      ).join('')}</div>
    </div>
    <div class="set-row"><span>Kaç puana kadar?</span>${seg('win', WIN_OPTIONS.map((v) => [v, v]), set.win)}</div>
    <div class="set-row"><span>Oy süresi</span>${seg('time', TIME_OPTIONS.map((v) => [v, v + ' sn']), set.time)}</div>
    <div class="set-row"><span>Şarkı nereden başlasın?</span>${seg('mid', [['1', 'Ortadan'], ['0', 'Baştan']], set.mid ? '1' : '0')}</div>
    <div class="set-row"><span>Explicit şarkılar</span>${seg('ex', [['1', 'Çalsın'], ['0', 'Çalmasın']], set.ex ? '1' : '0')}</div>`;
}

function lobbyView(st) {
  const host = isHost();
  const hostP = st.pl.find((p) => p.id === st.host);
  const can = host ? app.s.core.canStart() : null;
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
        <li>Şarkı çalınca, onu dinlediğini düşündüğün herkesi seç — kendin dahil.</li>
        <li>Aynı şarkıyı birkaç kişi dinliyor olabilir; istediğin kadar isim seçebilirsin.</li>
        <li>Her doğru isim <b class="up">+3</b>, her yanlış isim <b class="down">−1</b> puan.</li>
        <li><b>${st.set.win} puana</b> ilk ulaşan kazanır.</li>
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
  return `
  <section class="card board">
    <h3>Puan durumu <span class="count">hedef ${st.set.win}</span></h3>
    <ol>
      ${rows
        .map((p, i) => {
          const delta = reveal ? rd.dl?.[p.id] : null;
          const ballot = reveal ? rd.vt?.[p.id] : null;
          const votes = reveal
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
  const embedOn = !demo && playback.via !== 'local' && (playback.mode !== 'none' || !m);
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
  const stuck = volOn && playback.via === 'local' && playback.status === 'blocked';
  const canSave = !demo && spotify.authed();
  const saved = app.savedRound === rd.n;

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
      <div class="embed-wrap ${embedOn ? '' : 'hidden'}">
        <div id="embed" data-key="embed" data-keep></div>
        ${embedOn && playback.status === 'blocked' && playback.mode !== 'none' ? '<p class="note">Ses gelmiyorsa oynatıcıdaki ▶ düğmesine bir kez dokun.</p>' : ''}
        ${noVol ? `<p class="note">${noVol}</p>` : ''}
      </div>
      <div class="vol ${volOn ? '' : 'hidden'}" data-key="vol">
        <label>${icon('sound')}<input type="range" min="0" max="100" step="1" value="${Math.round(playback.level * 100)}" data-model="vol" aria-label="Ses düzeyi"></label>
        ${stuck ? '<button class="btn sm ghost" data-act="unmute">Sesi başlat</button>' : ''}
      </div>
      <div class="dock">${cta}</div>
    </div>
    ${boardView(st, P)}
  </main>`;
}

function wonView(st) {
  const P = new Map(st.pl.map((p) => [p.id, p]));
  const winners = st.win.ids.map((id) => P.get(id)).filter(Boolean);
  const names = winners.map((p) => esc(p.name)).join(' ve ') || 'Kimse';
  const hostP = P.get(st.host);
  return `
  <main class="won" data-key="won">
    <div class="trophy" style="--h:${winners[0]?.hue ?? 50}">${winners[0] ? esc(initial(winners[0].name)) : '?'}</div>
    <p class="kicker">Oyun bitti</p>
    <h2>${names} kazandı!</h2>
    ${st.win.out ? '<p class="note">Şarkılar tükendi; en yüksek puan kazandı.</p>' : ''}
    ${boardView(st, P)}
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

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !app.s) return;
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
  if (st.phase === 'vote' || st.phase === 'countdown') update();
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
