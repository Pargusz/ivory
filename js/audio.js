// Şarkıyı çalar. Dört yol var:
//   device → oyuncunun seçtiği Spotify cihazında çalar (Premium). Odaya girerken
//            "Spotify nerede açık?" adımında seçilir. Cihaz uykudaysa uyandırılır, çalmanın
//            gerçekten başladığı doğrulanır; başlamazsa kendiliğinden "web"e düşer.
//   web    → şarkı oyun sekmesinin içinde çalar; cihaz gerekmez. Premium hesapta sekme kendi
//            Spotify oynatıcısını kurar (Web Playback SDK): ses düzeyi ayarlanır, şarkı hemen
//            değişir. Kurulamazsa Spotify'ın gömülü oynatıcısına düşer (ses ayarı yoktur).
//   none   → ses yok.

import * as spotify from './spotify.js';
import { demoTone, stopTone, isDemo } from './demo.js';
import { ls, sleep, uid } from './util.js';

let apiReady = null;

function iframeApi() {
  apiReady ||= new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Spotify oynatıcısı yüklenemedi')), 10000);
    window.onSpotifyIframeApiReady = (api) => {
      clearTimeout(timer);
      resolve(api);
    };
    const s = document.createElement('script');
    s.src = 'https://open.spotify.com/embed/iframe-api/v1';
    s.async = true;
    s.onerror = () => {
      clearTimeout(timer);
      reject(new Error('Spotify oynatıcısı yüklenemedi'));
    };
    document.head.appendChild(s);
  });
  apiReady.catch(() => {
    apiReady = null;
  });
  return apiReady;
}

let sdkReady = null;

function playerSdk() {
  sdkReady ||= new Promise((resolve, reject) => {
    const fail = () => {
      clearTimeout(timer);
      reject(new Error('Spotify oynatıcısı yüklenemedi'));
    };
    const timer = setTimeout(fail, 10000);
    window.onSpotifyWebPlaybackSDKReady = () => {
      clearTimeout(timer);
      resolve(window.Spotify);
    };
    const s = document.createElement('script');
    s.src = 'https://sdk.scdn.co/spotify-player.js';
    s.async = true;
    s.onerror = fail;
    document.head.appendChild(s);
  });
  sdkReady.catch(() => {
    sdkReady = null;
  });
  return sdkReady;
}

const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));

export class Playback {
  constructor({ notify, onChange }) {
    this.notify = notify;
    this.onChange = onChange;
    this.mode = ls.get('audio', 'web');
    this.device = ls.get('device', null);
    this.token = 0;
    this.cur = null;
    this.status = 'idle'; // idle | loading | playing | blocked | ended (kesit bitti)
    this.limitTimer = 0;
    this.guard = 0; // kesit hiçbir yoldan durdurulamazsa devreye giren son emniyet
    this.tight = false;
    this.seeked = 0;
    this.seekAt = 0;
    this.devAt = 0;
    this.embedded = false; // gömülü oynatıcı ekranda mı
    this.ctrl = null;
    this.ctrlHost = null;
    this.wantStart = 0; // gömülü oynatıcıda şarkının başlaması istenen saniye
    this.ctrlStart = 0; // oynatıcıya şarkı hangi başlangıçla yüklendi
    this.loadedAt = 0;
    this.onDevice = false;
    this.warm = false; // son tur cihazda sorunsuz çaldı mı
    this.live = false; // gömülü oynatıcı bu şarkıyı çalmaya başladı mı
    this.ctrlUri = '';
    this.kicking = 0;
    this.via = null; // şarkı şu an nerede çalıyor: local | embed | device
    this.volume = clamp01(ls.get('vol', 0.5));
    this.devVolume = null; // seçili cihazın ses düzeyi; cihaz ses ayarını desteklemiyorsa null
    this.local = null; // sekme içi oynatıcı
    this.localId = null;
    // Oynatıcının Spotify'daki adı. Sekmeye özgüdür: Spotify oynatıcıyı bildirdiği kimlikle
    // tanımazsa ("Device not found") gerçek kimliği cihaz listesinde bu adla bulunur.
    this.localName = 'Ivory ' + uid(3);
    this.localOff = false; // sekme içi oynatıcı bu hesapta/tarayıcıda kurulamadı
    this.localWhy = ''; // kurulamadıysa nedeni (ekranda gösterilir)
    this.localFails = 0; // art arda geçici hata sayısı; üçte vazgeçilir
    this.startAt = 0; // şarkının (tamamı çalarken) başladığı an: canlandırırken kaldığı yeri bulmak için
    this.revivedAt = 0;
    this.revives = 0; // bu şarkı kaç kez yeniden başlatıldı
    this.connecting = null;
    this.volTimer = 0;
    this.eco = false; // kota dostu oda: Spotify'a istek atmadan, yalnızca gömülü oynatıcıdan çal
    // Tarayıcı, sekme içi oynatıcının ses açmasına ancak oyuncunun bir dokunuşundan sonra izin
    // verir; her dokunuşta izni tazeler.
    for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, () => this.local?.activateElement?.(), true);
  }

  // Bağlantı kopması gibi bir nedenle susan şarkıyı kaldığı yerden yeniden başlatır. İnternet
  // geri geldiğinde, sekme öne alındığında ve çalma sırasında düzenli olarak çağrılır; şarkı
  // gerçekten çalıyorsa hiçbir şey yapmaz.
  async revive() {
    const track = this.cur;
    const tk = this.token;
    if (!track || track.limit || this.mode === 'none' || !['playing', 'loading'].includes(this.status)) return;
    if (this.via !== 'local' || Date.now() - this.revivedAt < 5000 || this.revives >= 4) return;
    if (this.status === 'loading' && Date.now() - this.startAt < 8000) return;
    const st = await this.local?.getCurrentState().catch(() => null);
    if (tk !== this.token) return;
    const at = (track.pos || 0) + (Date.now() - this.startAt);
    // Çalıyorsa ya da şarkı zaten bittiyse dokunma.
    if ((st && !st.paused) || (st?.duration && at > st.duration - 3000)) return;
    this.revivedAt = Date.now();
    const count = this.revives + 1;
    await this.play({ ...track, pos: at });
    if (this.cur?.id === track.id) this.revives = count;
  }

  // Tam şarkı çalarken oynatıcıyı aralıklarla yoklar; susmuşsa canlandırır.
  async #nurse(tk) {
    while (tk === this.token) {
      await sleep(4000);
      if (tk !== this.token) return;
      if (document.visibilityState === 'visible') this.revive();
    }
  }

  // Odaya girerken çağrılır: oynatıcıyı, oyuncunun "gir" dokunuşu henüz tazeyken kurar ki ilk
  // şarkı "Sesi başlat"a basmayı gerektirmeden çalsın.
  prepare() {
    if (this.mode !== 'none') this.#connect();
  }

  // Ses düzeyi yalnızca sekme içi oynatıcıda ve ses ayarını destekleyen cihazda değişir.
  get canVolume() {
    return this.via === 'local' || (this.via === 'device' && this.devVolume != null);
  }

  get level() {
    return this.via === 'device' && this.devVolume != null ? this.devVolume : this.volume;
  }

  setVolume(v) {
    v = clamp01(v);
    if (this.via === 'device') {
      this.devVolume = v;
      clearTimeout(this.volTimer);
      this.volTimer = setTimeout(() => spotify.volume(this.device, Math.round(v * 100)).catch(() => {}), 200);
      return;
    }
    this.volume = v;
    ls.set('vol', v);
    this.local?.setVolume(v).catch(() => {});
  }

  // Tarayıcı sesi kendiliğinden başlatmadıysa, oyuncunun dokunuşuyla başlatır.
  resume() {
    if (this.via === 'embed') {
      try {
        this.ctrl?.play();
      } catch {}
      return;
    }
    if (this.via !== 'local' || !this.local) return;
    this.local.activateElement?.();
    // Kesit hiç duyulmadan engellendiyse baştan çal; yoksa kaldığı yerden sürdür.
    if (this.cur?.limit) this.play(this.cur);
    else this.local.resume().then(() => this.#set('playing'), () => {});
  }

  // Kesiti (track.limit) bitirir: ses nerede çalıyorsa orada susturur.
  #cut(tk) {
    if (tk !== this.token || this.status === 'ended') return;
    clearTimeout(this.limitTimer);
    clearTimeout(this.guard);
    this.limitTimer = 0;
    stopTone();
    this.#pauseEmbed();
    if (this.onDevice) spotify.pause(this.device).catch(() => {});
    if (this.via === 'local' && this.local) {
      this.local.pause().catch(() => {});
      this.#holdPaused(tk);
    }
    this.#set('ended');
  }

  #endAfter(tk, ms) {
    clearTimeout(this.limitTimer);
    this.limitTimer = setTimeout(() => this.#cut(tk), Math.max(0, ms));
  }

  // Sekme içi oynatıcıda duraklatma bazen tutmaz; gerçekten sustuğunu birkaç kez doğrular.
  async #holdPaused(tk) {
    for (let i = 0; i < 4; i++) {
      await sleep(250);
      if (tk !== this.token || this.status !== 'ended') return;
      const st = await this.local?.getCurrentState().catch(() => null);
      if (tk !== this.token || !st || st.paused) return;
      this.local?.pause().catch(() => {});
      spotify.pause(this.localId).catch(() => {});
    }
  }

  // Sekme içi oynatıcıda kesitin sonunu şarkının gerçek konumuna bakarak yakalar. Konum
  // okunamazsa duvar saatine düşer; her durumda kesit, süresinden en çok birkaç saniye sonra biter.
  async #watchLocal(tk, track) {
    const t0 = Date.now();
    const from = track.pos || 0;
    let zero = 0; // kesitin başladığı an (duvar saati)
    while (tk === this.token && this.status !== 'ended') {
      await sleep(100);
      const st = await this.local?.getCurrentState().catch(() => null);
      // Tarayıcı sesi engellediyse kesit sayılmaz; oyuncu "Sesi başlat"a basınca baştan çalar.
      if (tk !== this.token || this.status === 'blocked') return;
      const now = Date.now();
      const cur = st?.track_window?.current_track;
      const same = cur && (cur.id === track.id || cur.linked_from?.id === track.id || now - t0 > 3000);
      const heard = st && !st.paused && same ? st.position - from : -1;
      // Bir önceki şarkıdan kalan konumu sayma.
      const valid = heard >= 0 && heard <= now - t0 + 1500;
      if (valid && !zero) zero = now - heard;
      if ((valid && heard >= track.limit) || (zero && now - zero >= track.limit + 400) || now - t0 >= track.limit + 1500) {
        this.#cut(tk);
        return;
      }
    }
  }

  #go(via) {
    if (this.via === via) return;
    this.via = via;
    this.onChange?.();
  }

  setMode(mode, device) {
    this.mode = mode;
    ls.set('audio', mode);
    this.localOff = false;
    this.localWhy = '';
    this.localFails = 0;
    if (device !== undefined) {
      this.device = device;
      this.warm = false;
      this.devVolume = null;
      ls.set('device', device);
    }
    const cur = this.cur;
    this.stop();
    if (cur) this.play(cur);
  }

  #set(status) {
    if (this.status === status) return;
    this.status = status;
    this.onChange?.();
  }

  // track: { id, pos, limit, secret }. limit verilirse şarkı o kadar milisaniye çalıp durur.
  // secret: şarkının adı oyuncunun Spotify uygulamasında görünmemeli. Spotify hesabına bağlı
  // oynatıcılarda (seçili cihaz, sekme içi oynatıcı) çalan şarkı uygulamada "şu an çalıyor"
  // diye görünür; gömülü oynatıcıda çalan görünmez. Bu yüzden gizli şarkı yalnızca gömülü
  // oynatıcıda çalar (orada ses düzeyi ayarlanamaz).
  async play(track) {
    const tk = ++this.token;
    this.cur = track;
    this.startAt = Date.now();
    this.revives = 0;
    clearTimeout(this.limitTimer);
    clearTimeout(this.guard);
    this.limitTimer = 0;
    this.tight = false;
    if (track.limit) this.guard = setTimeout(() => this.#cut(tk), track.limit + 10000);
    stopTone();
    if (this.mode === 'none') {
      this.#quiet();
      this.#set('idle');
      return;
    }
    this.#set('loading');
    if (isDemo(track.id)) {
      this.#set(demoTone(track.id) ? 'playing' : 'blocked');
      if (track.limit) this.#endAfter(tk, track.limit);
      return;
    }
    // Spotify istekleri reddediyorsa (kota) cihazda ya da sekme içi oynatıcıda çalmak mümkün
    // değil; ikisi de istek gerektirir. Gömülü oynatıcı istek harcamaz: doğrudan ona geçilir.
    const limited = this.eco || spotify.blockedFor() > 0;
    if (track.secret || limited) {
      if (this.via === 'local' && this.local) {
        this.local.pause().catch(() => {});
        this.#ensureQuiet(tk);
      }
      if (this.onDevice) {
        this.onDevice = false;
        spotify.pause(this.device).catch(() => {});
      }
    } else if (this.mode === 'device') {
      this.#pauseEmbed();
      const ok = await this.#onDevice(track, tk);
      if (tk !== this.token) return;
      if (ok) {
        this.onDevice = true;
        this.#go('device');
        this.#set('playing');
        if (track.limit) this.#endAfter(tk, track.limit - this.devAt);
        return;
      }
      this.notify('Spotify cihazında açılamadı — şarkı bu sekmede çalıyor');
    }
    const ok = !track.secret && !limited && (await this.#onLocal(track, tk));
    if (tk !== this.token) return;
    if (ok) {
      this.#pauseEmbed();
      this.#go('local');
      this.#set('playing');
      this.startAt = Date.now();
      if (track.limit) this.#watchLocal(tk, track);
      else this.#nurse(tk);
      return;
    }
    this.#go('embed');
    await this.#embed(track, tk);
  }

  stop() {
    this.token++;
    this.cur = null;
    clearTimeout(this.guard);
    clearTimeout(this.limitTimer);
    this.limitTimer = 0;
    stopTone();
    this.#quiet();
    this.#set('idle');
  }

  #quiet() {
    this.#pauseEmbed();
    if (this.via === 'local' && this.local) {
      this.local.pause().catch(() => {});
      this.#ensureQuiet(this.token);
    }
    if (this.onDevice) {
      this.onDevice = false;
      spotify.pause(this.device).catch(() => {});
    }
  }

  // Sekme arka plandayken tarayıcı sesi hiç başlatmaz ve oynatıcının kendi duraklatması tutmaz;
  // Spotify tarafında şarkı çalıyor görünmeye devam eder. O durumda Spotify üzerinden durdurur.
  async #ensureQuiet(tk) {
    await sleep(500);
    if (tk !== this.token) return;
    const st = await this.local?.getCurrentState().catch(() => null);
    if (tk === this.token && st && !st.paused) spotify.pause(this.localId).catch(() => {});
  }

  #pauseEmbed() {
    try {
      this.ctrl?.pause();
    } catch {}
  }

  // Cihazı bul → uykudaysa uyandır → çal → gerçekten çalıyor mu bak. Olmazsa yeniden dener.
  // Bir önceki tur sorunsuz çaldıysa cihaz aramayı atlayıp doğrudan çalar.
  async #onDevice(track, tk) {
    if (!spotify.authed()) return false;
    const uri = 'spotify:track:' + track.id;
    const tries = this.warm ? 3 : 2;
    for (let attempt = 0; attempt < tries; attempt++) {
      try {
        if (!this.warm) {
          const list = (await spotify.devices()).filter((d) => d.id !== this.localId && !d.name.startsWith('Ivory'));
          const dev = list.find((d) => d.id === this.device) || list.find((d) => d.is_active) || (list.length === 1 ? list[0] : null);
          if (!dev) return false;
          if (dev.id !== this.device) {
            this.device = dev.id;
            ls.set('device', dev.id);
          }
          if (!dev.is_active) {
            await spotify.transfer(dev.id);
            await sleep(700);
          }
        }
        if (tk !== this.token) return true;
        await spotify.play(this.device, uri, track.pos);
        await sleep(1300);
        if (tk !== this.token) return true;
        const st = await spotify.playerState();
        if (st?.is_playing && (!st.device?.id || st.device.id === this.device)) {
          const vol = st.device?.volume_percent;
          this.devAt = Math.max(0, (st.progress_ms || 0) - (track.pos || 0));
          this.devVolume = st.device?.supports_volume !== false && typeof vol === 'number' ? vol / 100 : null;
          this.warm = true;
          return true;
        }
      } catch (e) {
        if (e.status === 401 || e.reason === 'PREMIUM_REQUIRED') return false;
      }
      this.warm = false;
      await sleep(500);
    }
    return false;
  }

  // Sekme içi oynatıcıyı bir kez kurar ve Spotify'a cihaz olarak tanıtır. Kurulamazsa
  // (Premium yok, izin eksik, tarayıcı desteklemiyor) null döner.
  #connect() {
    if (this.localOff || !spotify.canStream()) return Promise.resolve(null);
    this.connecting ||= (async () => {
      const sdk = await playerSdk();
      const player = new sdk.Player({
        name: this.localName,
        volume: this.volume,
        getOAuthToken: (cb) => spotify.accessToken().then(cb, () => cb('')),
      });
      const id = await new Promise((resolve) => {
        // fatal: yeniden denemenin anlamı yok (Premium yok, izin yok, tarayıcı desteklemiyor).
        let settled = false;
        const fail = (why, fatal) => {
          if (settled) return;
          settled = true;
          this.localWhy ||= why;
          if (fatal) this.localOff = true;
          resolve(null);
        };
        player.addListener('ready', ({ device_id }) => {
          settled = true;
          this.localId = device_id;
          resolve(device_id);
        });
        player.addListener('initialization_error', (e) => fail('tarayıcı desteklemiyor (' + e.message + ')', true));
        player.addListener('authentication_error', (e) => fail('Spotify izni reddedildi (' + e.message + ')', true));
        player.addListener('account_error', () => fail('Spotify Premium gerekli', true));
        setTimeout(() => fail('oynatıcı zamanında hazır olmadı'), 8000);
        player.connect().then((ok) => ok || fail('bağlanamadı'), () => fail('bağlanamadı'));
      });
      if (!id) {
        player.disconnect();
        return null;
      }
      // Oynatıcı Spotify'dan düşüp geri geldiğinde (ağ kesintisi) susan şarkıyı sürdür.
      player.addListener('ready', () => setTimeout(() => this.revive(), 800));
      player.addListener('playback_error', () => setTimeout(() => this.revive(), 1500));
      player.addListener('autoplay_failed', () => {
        if (this.via !== 'local' || !this.cur) return;
        clearTimeout(this.guard);
        clearTimeout(this.limitTimer);
        this.limitTimer = 0;
        this.#set('blocked');
      });
      // Odaya girerkenki dokunuş hâlâ tazeyse ses izni şimdi alınır.
      player.activateElement?.();
      this.local = player;
      return id;
    })()
      .catch((e) => {
        this.localWhy ||= e.message;
        return null;
      })
      .then((id) => {
        // Geçici bir aksaklık (ağ, zaman aşımı) oynatıcıyı oyunun sonuna kadar kapatmasın.
        if (!id) {
          this.connecting = null;
          if (++this.localFails >= 3) this.localOff = true;
        }
        return id;
      });
    return this.connecting;
  }

  async #findLocal() {
    const list = await spotify.devices().catch(() => []);
    return list.find((d) => d.name === this.localName)?.id || null;
  }

  async #onLocal(track, tk) {
    if (!(await this.#connect())) return false;
    const uri = 'spotify:track:' + track.id;
    let why = '';
    // Oynatıcı yeni kurulduysa Spotify onu bir an tanımayabilir; kısa aralıklarla yeniden dener.
    for (let attempt = 0; attempt < 4; attempt++) {
      if (tk !== this.token) return true;
      try {
        await spotify.play(this.localId, uri, track.pos);
        // Şarkı açılırken tur bittiyse çalmaya devam etmesin.
        if (tk !== this.token && !this.cur) this.local?.pause().catch(() => {});
        this.localFails = 0;
        this.localWhy = '';
        return true;
      } catch (e) {
        // Spotify istekleri geçici olarak sınırlıyorsa oynatıcıyı kusurlu sayma; bu şarkı gömülü
        // oynatıcıda çalar, sınır kalkınca sekme içi oynatıcıya dönülür.
        if (e.status === 429) return false;
        why = (e.reason === 'PREMIUM_REQUIRED' ? 'Spotify Premium gerekli' : e.message) + ' (' + e.status + ')';
        if (e.status === 401 || e.status === 403) break;
        // Spotify oynatıcıyı bu kimlikle tanımıyor: gerçek kimliği cihaz listesinden bul.
        // Listede de yoksa (ağ kesintisinden sonra düşmüş) aynı oynatıcıyı yeniden bağla.
        const id = await this.#findLocal();
        if (id) this.localId = id;
        else if (attempt === 1) {
          await this.local?.connect().catch(() => {});
          await sleep(1200);
        }
      }
      await sleep(350);
    }
    // Oynatıcı bırakılıp yeniden kurulmaz: Spotify aynı sayfada ikinci kez kurulan oynatıcıyı
    // tanımıyor. Aynı oynatıcı sıradaki şarkıda yeniden denenir.
    this.localWhy = why;
    if (/\((401|403)\)$/.test(why) || ++this.localFails >= 3) this.localOff = true;
    return false;
  }

  async #embed(track, tk) {
    let api;
    try {
      api = await iframeApi();
    } catch (e) {
      if (tk === this.token) {
        this.notify(e.message);
        this.#set('blocked');
      }
      return;
    }
    let host = null;
    for (let i = 0; i < 40 && tk === this.token; i++) {
      host = document.getElementById('embed');
      if (host) break;
      await sleep(50);
    }
    if (tk !== this.token || !host) return;

    const uri = 'spotify:track:' + track.id;
    // Şarkı ortadan başlayacaksa oynatıcıya yüklenirken söylenir: çalmaya başladıktan sonra
    // sarmak (seek) tam şarkıda tutmuyor.
    const start = track.pos > 0 ? Math.floor(track.pos / 1000) : 0;
    this.loadedAt = Date.now();
    this.live = false;
    this.wantStart = start;
    this.seeked = start * 1000;
    this.seekAt = this.loadedAt;
    if (this.ctrl && this.ctrlHost === host && host.querySelector('iframe')) {
      if (this.ctrlUri === uri && this.ctrlStart === start) {
        // Aynı şarkı, aynı yer (kesiti yeniden dinleme, sonraki aşama): yeniden yüklemeden çal.
        // play() yüklenirken verilen başlangıca, restart() şarkının başına döner.
        if (start || typeof this.ctrl.restart !== 'function') this.ctrl.play();
        else this.ctrl.restart();
        this.#kick(tk, true);
      } else {
        this.ctrlUri = uri;
        this.ctrlStart = start;
        this.ctrl.loadUri(uri, false, start);
        this.#kick(tk);
      }
      return;
    }
    host.innerHTML = '<div></div>';
    this.ctrl = null;
    this.ctrlHost = host;
    this.ctrlUri = uri;
    this.ctrlStart = 0;
    api.createController(host.firstChild, { uri, width: '100%', height: 80 }, (ctrl) => {
      this.ctrl = ctrl;
      ctrl.addListener('ready', () => this.#ready());
      ctrl.addListener('playback_update', (e) => this.#update(e.data));
    });
  }

  // Oynatıcı şarkıyı yükledi. İlk kurulumda şarkı baştan yüklenir; ortadan başlaması
  // isteniyorsa önce o başlangıçla yeniden yüklenir (bu olay bir kez daha gelir).
  #ready() {
    if (this.cur && this.wantStart > 0 && this.ctrlStart !== this.wantStart && this.ctrlUri === 'spotify:track:' + this.cur.id) {
      this.ctrlStart = this.wantStart;
      this.ctrl.loadUri(this.ctrlUri, false, this.wantStart);
      return;
    }
    this.#kick(this.token);
  }

  // Gömülü oynatıcıyı başlatır. play() çalmakta olan şarkıyı baştan başlattığı için yalnızca
  // şarkı hiç başlamadıysa (tarayıcı otomatik çalmayı geciktirdiyse) yinelenir.
  async #kick(tk, started = false) {
    if (this.kicking === tk) return;
    this.kicking = tk;
    for (const wait of started ? [2500, 3000] : [0, 2500, 3000]) {
      await sleep(wait);
      if (tk !== this.token || !this.ctrl || this.live || this.status === 'ended') return;
      try {
        this.ctrl.play();
      } catch {}
    }
    await sleep(3000);
    if (tk === this.token && !this.live && this.status !== 'ended') this.#set('blocked');
  }

  #update(data) {
    if (!data || !this.cur) return;
    // Yeni şarkı yüklenirken bir önceki şarkıya ait gecikmiş bildirimleri sayma.
    const stale = data.playingURI && data.playingURI !== 'spotify:track:' + this.cur.id && Date.now() - this.loadedAt < 1500;
    if (stale) return;
    if (!data.isPaused) this.live = true;
    const now = Date.now();
    const playing = !data.isPaused && !data.isBuffering;
    // 30 saniyelik önizleme (tarayıcıda Spotify'a girilmemiş) ortadan başlatılamaz: baştan yükle.
    if (this.ctrlStart > 0 && data.duration > 0 && data.duration <= 60000) {
      this.ctrlStart = this.wantStart = this.seeked = 0;
      this.kicking = 0;
      this.loadedAt = now;
      this.ctrl.loadUri(this.ctrlUri, false, 0);
      this.#kick(this.token);
      return;
    }
    // Ses başladı: bundan sonra konum bildirimi gelmese de kesit en geç birkaç saniye içinde biter.
    if (playing && this.cur.limit && this.status !== 'ended' && !this.tight) {
      const tk = this.token;
      this.tight = true;
      clearTimeout(this.guard);
      this.guard = setTimeout(() => this.#cut(tk), this.cur.limit + 3500);
    }
    if (playing && this.cur.limit && this.status !== 'ended' && !this.limitTimer) {
      // Kesit süresi sesin başladığı andan sayılır. Şarkı ortadan başlatıldıysa (seeked) konumun
      // oraya gelmesi beklenir; sarma tutmadıysa beklemeyi bırakıp buradan sayar.
      let heard = data.position - this.seeked;
      if (heard < -1000) {
        if (now - this.seekAt < 2500) heard = null;
        else this.seeked = heard = 0;
      }
      if (heard != null) {
        if (heard < 0 || heard > now - this.loadedAt + 1500) heard = 0;
        this.#endAfter(this.token, this.cur.limit - heard);
      }
    }
    if (this.status === 'ended') return;
    if (playing) this.#set('playing');
    else if (this.status === 'playing' && data.isPaused) this.#set('blocked');
  }
}
