// Oda kanalı: aynı anda birkaç genel MQTT sunucusuna bağlanır, her mesajı hepsine yollar
// ve tekrarları ayıklar. Sunuculardan biri düşse ya da engellense oda çalışmaya devam eder.
// Mesajlar oda kodundan türetilen anahtarla (AES-GCM) uçtan uca şifrelenir.

import { MqttClient } from './mqtt.js';
import { onTick, uid } from './util.js';

const te = new TextEncoder();
const td = new TextDecoder();
const SEEN_LIMIT = 4000;

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(text)));
}

export class Channel {
  // host: true → oyunculardan gelenleri dinler, herkese yayınlar. false → tersi.
  constructor({ code, id, host, brokers, onMessage, onChange }) {
    this.code = code;
    this.id = id;
    this.host = host;
    this.brokers = brokers;
    this.onMessage = onMessage;
    this.onChange = onChange;
    this.nonce = uid(4);
    this.seq = 0;
    this.seen = new Set();
    this.seenQueue = [];
    this.clients = [];
    this.closed = false;
  }

  async open() {
    const topicHash = [...(await sha256('ivory/1/topic/' + this.code))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const base = 'ivory1/' + topicHash.slice(0, 24);
    this.key = await crypto.subtle.importKey('raw', await sha256('ivory/1/key/' + this.code), 'AES-GCM', false, ['encrypt', 'decrypt']);
    this.out = base + (this.host ? '/h' : '/c');
    if (this.closed) return;
    this.clients = this.brokers.map((url) => {
      const c = new MqttClient(url, {
        onMessage: (topic, payload) => this.#receive(payload),
        onChange: () => this.onChange?.(),
      });
      // Host kendi yayın kanalını da dinler: aynı odayı ikinci bir sekme yönetmeye kalkarsa fark eder.
      c.subscribe(base + '/h');
      if (this.host) c.subscribe(base + '/c');
      c.start();
      return c;
    });
    this.offTick = onTick((now) => {
      for (const c of this.clients) c.tick(now);
    });
  }

  get links() {
    return this.clients.filter((c) => c.connected).length;
  }

  get online() {
    return this.links > 0;
  }

  nudge() {
    for (const c of this.clients) c.nudge();
  }

  async send(msg) {
    if (this.closed || !this.key) return false;
    const env = { ...msg, f: this.id, q: this.nonce + (this.seq++).toString(36) };
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.key, te.encode(JSON.stringify(env))));
    const data = new Uint8Array(12 + ct.length);
    data.set(iv, 0);
    data.set(ct, 12);
    let sent = false;
    for (const c of this.clients) sent = c.publish(this.out, data) || sent;
    return sent;
  }

  close() {
    this.closed = true;
    this.offTick?.();
    for (const c of this.clients) c.stop();
    this.clients = [];
  }

  async #receive(payload) {
    let msg;
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: payload.subarray(0, 12) }, this.key, payload.subarray(12));
      msg = JSON.parse(td.decode(plain));
    } catch {
      return;
    }
    if (this.closed || !msg || !msg.f || !msg.q) return;
    if (msg.f === this.id && msg.q.startsWith(this.nonce)) return;
    const tag = msg.f + '/' + msg.q;
    if (this.seen.has(tag)) return;
    this.seen.add(tag);
    this.seenQueue.push(tag);
    if (this.seenQueue.length > SEEN_LIMIT) this.seen.delete(this.seenQueue.shift());
    this.onMessage?.(msg);
  }
}
