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
import { ls, sleep } from './util.js';

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
    this.devAt = 0;
    this.embedded = false; // gömülü oynatıcı ekranda mı
    this.ctrl = null;
    this.ctrlHost = null;
    this.wantSeek = null;
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
    this.localOff = false; // sekme içi oynatıcı bu hesapta/tarayıcıda kurulamadı
    this.localWhy = ''; // kurulamadıysa nedeni (ekranda gösterilir)
    this.connecting = null;
    this.volTimer = 0;
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
    this.local.resume().then(() => this.#set('playing'), () => {});
  }

  // Kesit çalarken (track.limit) süre dolunca sesi keser.
  #endAfter(tk, ms, quiet) {
    clearTimeout(this.limitTimer);
    this.limitTimer = setTimeout(() => {
      this.limitTimer = 0;
      if (tk !== this.token) return;
      quiet();
      this.#set('ended');
    }, Math.max(0, ms));
  }

  // Sekme içi oynatıcıda kesitin sonunu şarkının gerçek konumuna bakarak yakalar.
  async #watchLocal(tk, track) {
    const t0 = Date.now();
    while (tk === this.token) {
      await sleep(120);
      const st = await this.local.getCurrentState().catch(() => null);
      if (tk !== this.token) return;
      const cur = st?.track_window?.current_track;
      const same = cur && (cur.id === track.id || cur.linked_from?.id === track.id);
      const waited = Date.now() - t0;
      if (!same && waited < 2500) continue;
      const at = st && !st.paused ? st.position - (track.pos || 0) : -1;
      if (at >= track.limit || waited > track.limit + 5000) {
        this.local.pause().catch(() => {});
        this.#set('ended');
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
  // secret: şarkı Spotify hesabına bağlı bir oynatıcıda (cihaz ya da sekme içi) çalmaz, çünkü
  // oralarda çalan şarkının adı oyuncunun Spotify uygulamasında görünür; gömülü oynatıcıda çalar.
  async play(track) {
    const tk = ++this.token;
    this.cur = track;
    clearTimeout(this.limitTimer);
    this.limitTimer = 0;
    stopTone();
    if (this.mode === 'none') {
      this.#quiet();
      this.#set('idle');
      return;
    }
    this.#set('loading');
    if (isDemo(track.id)) {
      this.#set(demoTone(track.id) ? 'playing' : 'blocked');
      if (track.limit) this.#endAfter(tk, track.limit, stopTone);
      return;
    }
    if (track.secret) {
      if (this.via === 'local') this.local?.pause().catch(() => {});
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
        if (track.limit) this.#endAfter(tk, track.limit - this.devAt, () => spotify.pause(this.device).catch(() => {}));
        return;
      }
      this.notify('Spotify cihazında açılamadı — şarkı bu sekmede çalıyor');
    }
    const ok = !track.secret && (await this.#onLocal(track, tk));
    if (tk !== this.token) return;
    if (ok) {
      this.#pauseEmbed();
      this.#go('local');
      this.#set('playing');
      if (track.limit) this.#watchLocal(tk, track);
      return;
    }
    this.#go('embed');
    await this.#embed(track, tk);
  }

  stop() {
    this.token++;
    this.cur = null;
    clearTimeout(this.limitTimer);
    this.limitTimer = 0;
    stopTone();
    this.#quiet();
    this.#set('idle');
  }

  #quiet() {
    this.#pauseEmbed();
    if (this.via === 'local') this.local?.pause().catch(() => {});
    if (this.onDevice) {
      this.onDevice = false;
      spotify.pause(this.device).catch(() => {});
    }
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
          const list = (await spotify.devices()).filter((d) => d.id !== this.localId);
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
        name: 'Ivory',
        volume: this.volume,
        getOAuthToken: (cb) => spotify.accessToken().then(cb, () => cb('')),
      });
      const id = await new Promise((resolve) => {
        const fail = (why) => {
          this.localWhy ||= why;
          resolve(null);
        };
        player.addListener('ready', ({ device_id }) => {
          this.localId = device_id;
          resolve(device_id);
        });
        player.addListener('initialization_error', (e) => fail('tarayıcı desteklemiyor (' + e.message + ')'));
        player.addListener('authentication_error', (e) => fail('Spotify izni reddedildi (' + e.message + ')'));
        player.addListener('account_error', () => fail('Spotify Premium gerekli'));
        setTimeout(() => fail('oynatıcı zamanında hazır olmadı'), 8000);
        player.connect().then((ok) => ok || fail('bağlanamadı'), () => fail('bağlanamadı'));
      });
      if (!id) {
        player.disconnect();
        return null;
      }
      player.addListener('autoplay_failed', () => {
        if (this.via === 'local' && this.cur) this.#set('blocked');
      });
      // Telefonda ses, oyuncunun bir dokunuşundan sonra açılır.
      document.addEventListener('pointerdown', () => player.activateElement?.(), { once: true });
      this.local = player;
      return id;
    })()
      .catch((e) => {
        this.localWhy ||= e.message;
        return null;
      })
      .then((id) => {
        if (!id) {
          this.localOff = true;
          this.connecting = null;
        }
        return id;
      });
    return this.connecting;
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
        if (tk !== this.token && !this.cur) this.local.pause().catch(() => {});
        return true;
      } catch (e) {
        why = (e.reason === 'PREMIUM_REQUIRED' ? 'Spotify Premium gerekli' : e.message) + ' (' + e.status + ')';
        if (e.status === 401 || e.status === 403) break;
      }
      await sleep(350);
    }
    this.localWhy = why;
    this.localOff = true;
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
    this.wantSeek = track.pos > 0 ? Math.floor(track.pos / 1000) : null;
    this.loadedAt = Date.now();
    this.live = false;
    this.seeked = 0;
    if (this.ctrl && this.ctrlHost === host && host.querySelector('iframe')) {
      if (this.ctrlUri === uri && typeof this.ctrl.restart === 'function') {
        // Aynı şarkı (kesiti yeniden dinleme, sonraki aşama): yeniden yüklemeden baştan çal.
        this.ctrl.restart();
        this.#kick(tk, true);
      } else {
        this.ctrlUri = uri;
        this.ctrl.loadUri(uri);
        this.#kick(tk);
      }
      return;
    }
    host.innerHTML = '<div></div>';
    this.ctrl = null;
    this.ctrlHost = host;
    this.ctrlUri = uri;
    api.createController(host.firstChild, { uri, width: '100%', height: 80 }, (ctrl) => {
      this.ctrl = ctrl;
      ctrl.addListener('ready', () => this.#kick(this.token));
      ctrl.addListener('playback_update', (e) => this.#update(e.data));
    });
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
    const stale = data.playingURI && data.playingURI !== 'spotify:track:' + this.cur.id && Date.now() - this.loadedAt < 4000;
    if (stale) return;
    if (!data.isPaused) this.live = true;
    const playing = !data.isPaused && !data.isBuffering;
    if (playing && this.wantSeek != null && data.duration > 0) {
      // 30 saniyelik önizlemede ortaya sarmanın anlamı yok; yalnızca tam şarkıda sar.
      const at = this.wantSeek;
      this.wantSeek = null;
      if (data.duration > 60000 && at * 1000 < data.duration - 20000 && data.position < 5000) {
        try {
          this.ctrl.seek(at);
          this.seeked = at * 1000;
        } catch {}
      }
    }
    // Yeniden başlatmanın hemen ardından eski konum gelebilir; kesit süresini ona göre kurma.
    // Süre, ses gerçekten ilerlemeye başlayınca (konum > 0) kurulur ki kesit kısa kalmasın.
    // Şarkı ortadan başlatıldıysa (seeked) süre, sarılan yerden itibaren sayılır.
    const heard = data.position - this.seeked;
    const sane = heard > 0 && heard <= Date.now() - this.loadedAt + 1500;
    if (playing && sane && this.cur.limit && this.status !== 'ended' && !this.limitTimer) {
      this.#endAfter(this.token, this.cur.limit - heard, () => this.#pauseEmbed());
    }
    if (this.status === 'ended') return;
    if (playing) this.#set('playing');
    else if (this.status === 'playing' && data.isPaused) this.#set('blocked');
  }
}
