// Şarkıyı çalar. Üç yol var:
//   device → oyuncunun seçtiği Spotify cihazında çalar (Premium). Odaya girerken
//            "Spotify nerede açık?" adımında seçilir. Cihaz uykudaysa uyandırılır, çalmanın
//            gerçekten başladığı doğrulanır; başlamazsa kendiliğinden "web"e düşer.
//   web    → şarkı oyun sekmesinin içinde çalar (Spotify gömülü oynatıcı); cihaz gerekmez.
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

export class Playback {
  constructor({ notify, onChange }) {
    this.notify = notify;
    this.onChange = onChange;
    this.mode = ls.get('audio', 'web');
    this.device = ls.get('device', null);
    this.token = 0;
    this.cur = null;
    this.status = 'idle'; // idle | loading | playing | blocked
    this.embedded = false; // gömülü oynatıcı ekranda mı
    this.ctrl = null;
    this.ctrlHost = null;
    this.wantSeek = null;
    this.loadedAt = 0;
    this.onDevice = false;
    this.warm = false; // son tur cihazda sorunsuz çaldı mı
  }

  setMode(mode, device) {
    this.mode = mode;
    ls.set('audio', mode);
    if (device !== undefined) {
      this.device = device;
      this.warm = false;
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

  async play(track) {
    const tk = ++this.token;
    this.cur = track;
    stopTone();
    if (this.mode === 'none') {
      this.#quiet();
      this.#set('idle');
      return;
    }
    this.#set('loading');
    if (isDemo(track.id)) {
      this.#set(demoTone(track.id) ? 'playing' : 'blocked');
      return;
    }
    if (this.mode === 'device') {
      this.#pauseEmbed();
      const ok = await this.#onDevice(track, tk);
      if (tk !== this.token) return;
      if (ok) {
        this.onDevice = true;
        this.#set('playing');
        return;
      }
      this.notify('Spotify cihazında açılamadı — şarkı bu sekmede çalıyor');
    }
    await this.#embed(track, tk);
  }

  stop() {
    this.token++;
    this.cur = null;
    stopTone();
    this.#quiet();
    this.#set('idle');
  }

  #quiet() {
    this.#pauseEmbed();
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
          const list = await spotify.devices();
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
    if (this.ctrl && this.ctrlHost === host && host.querySelector('iframe')) {
      this.ctrl.loadUri(uri);
      this.#kick(tk);
      return;
    }
    host.innerHTML = '<div></div>';
    this.ctrl = null;
    this.ctrlHost = host;
    api.createController(host.firstChild, { uri, width: '100%', height: 80 }, (ctrl) => {
      this.ctrl = ctrl;
      ctrl.addListener('ready', () => this.#kick(this.token));
      ctrl.addListener('playback_update', (e) => this.#update(e.data));
    });
  }

  // Tarayıcı otomatik çalmayı geciktirebilir; kısa aralıklarla birkaç kez dener.
  async #kick(tk) {
    for (const wait of [0, 700, 1600, 3000]) {
      await sleep(wait);
      if (tk !== this.token || !this.ctrl || this.status === 'playing') return;
      try {
        this.ctrl.play();
      } catch {}
    }
    await sleep(1500);
    if (tk === this.token && this.status !== 'playing') this.#set('blocked');
  }

  #update(data) {
    if (!data || !this.cur) return;
    // Yeni şarkı yüklenirken bir önceki şarkıya ait gecikmiş bildirimleri sayma.
    const stale = data.playingURI && data.playingURI !== 'spotify:track:' + this.cur.id && Date.now() - this.loadedAt < 1500;
    if (stale) return;
    const playing = !data.isPaused && !data.isBuffering;
    if (playing && this.wantSeek != null && data.duration > 0) {
      // 30 saniyelik önizlemede ortaya sarmanın anlamı yok; yalnızca tam şarkıda sar.
      const at = this.wantSeek;
      this.wantSeek = null;
      if (data.duration > 60000 && at * 1000 < data.duration - 20000 && data.position < 5000) {
        try {
          this.ctrl.seek(at);
        } catch {}
      }
    }
    if (playing) this.#set('playing');
    else if (this.status === 'playing' && data.isPaused) this.#set('blocked');
  }
}
