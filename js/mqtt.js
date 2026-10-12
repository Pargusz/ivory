// WebSocket üzerinden çalışan küçük bir MQTT 3.1.1 istemcisi (yalnızca QoS 0).
// Zamanlayıcı kullanmaz; yeniden bağlanma ve canlılık kontrolü dışarıdan gelen tick() ile yürür.

const te = new TextEncoder();
const td = new TextDecoder();

function utf8(s) {
  const b = te.encode(s);
  const out = new Uint8Array(b.length + 2);
  out[0] = b.length >> 8;
  out[1] = b.length & 0xff;
  out.set(b, 2);
  return out;
}

function packet(header, ...parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const head = [header];
  let n = len;
  do {
    let d = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) d |= 0x80;
    head.push(d);
  } while (n > 0);
  const out = new Uint8Array(head.length + len);
  out.set(head, 0);
  let o = head.length;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const PING = new Uint8Array([0xc0, 0]);
const CONNECT_TIMEOUT = 9000;
const SILENCE_LIMIT = 50000;
const PING_EVERY = 20000;

export class MqttClient {
  constructor(url, { onMessage, onChange } = {}) {
    this.url = url;
    this.onMessage = onMessage;
    this.onChange = onChange;
    this.subs = new Set();
    this.ws = null;
    this.connected = false;
    this.stopped = true;
    this.buf = new Uint8Array(0);
    this.backoff = 800;
    this.retryAt = 0;
    this.openedAt = 0;
    this.lastIn = 0;
    this.lastOut = 0;
    this.pid = 1;
  }

  start() {
    this.stopped = false;
    this.#open();
  }

  stop() {
    this.stopped = true;
    if (this.connected) this.#send(new Uint8Array([0xe0, 0]));
    this.#drop();
  }

  subscribe(topic) {
    this.subs.add(topic);
    if (this.connected) this.#sendSub([topic]);
  }

  publish(topic, payload) {
    if (!this.connected) return false;
    return this.#send(packet(0x30, utf8(topic), payload));
  }

  tick(now) {
    if (this.stopped) return;
    if (!this.ws) {
      if (now >= this.retryAt) this.#open();
    } else if (!this.connected) {
      if (now - this.openedAt > CONNECT_TIMEOUT) this.#drop();
    } else if (now - this.lastIn > SILENCE_LIMIT) {
      this.#drop();
    } else if (now - this.lastOut > PING_EVERY) {
      this.#send(PING);
    }
  }

  // Sekme uykudan dönünce beklemeden yeniden dene.
  nudge() {
    this.retryAt = 0;
    this.backoff = 800;
  }

  #open() {
    let ws;
    try {
      ws = new WebSocket(this.url, 'mqtt');
    } catch {
      this.#scheduleRetry();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.openedAt = Date.now();
    this.buf = new Uint8Array(0);
    ws.onopen = () => {
      if (this.ws !== ws) return;
      const clientId = 'ivory' + Math.random().toString(36).slice(2, 14);
      this.#send(packet(0x10, utf8('MQTT'), new Uint8Array([4, 2, 0, 60]), utf8(clientId)));
    };
    ws.onmessage = (e) => {
      if (this.ws === ws) this.#feed(new Uint8Array(e.data));
    };
    ws.onclose = ws.onerror = () => {
      if (this.ws === ws) this.#drop();
    };
  }

  #scheduleRetry() {
    this.retryAt = Date.now() + this.backoff;
    this.backoff = Math.min(this.backoff * 1.7, 8000);
  }

  #drop() {
    const ws = this.ws;
    const was = this.connected;
    this.ws = null;
    this.connected = false;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {}
    }
    this.#scheduleRetry();
    if (was) this.onChange?.(false);
  }

  #send(bytes) {
    try {
      this.ws.send(bytes);
      this.lastOut = Date.now();
      return true;
    } catch {
      return false;
    }
  }

  #sendSub(topics) {
    const id = this.pid++ & 0xffff || 1;
    const parts = [new Uint8Array([id >> 8, id & 0xff])];
    for (const t of topics) parts.push(utf8(t), new Uint8Array([0]));
    this.#send(packet(0x82, ...parts));
  }

  #feed(chunk) {
    this.lastIn = Date.now();
    let buf = chunk;
    if (this.buf.length) {
      buf = new Uint8Array(this.buf.length + chunk.length);
      buf.set(this.buf, 0);
      buf.set(chunk, this.buf.length);
    }
    let pos = 0;
    while (buf.length - pos >= 2) {
      let len = 0;
      let mult = 1;
      let i = pos + 1;
      let done = false;
      while (i < buf.length && i - pos <= 4) {
        const d = buf[i++];
        len += (d & 0x7f) * mult;
        mult *= 128;
        if (!(d & 0x80)) {
          done = true;
          break;
        }
      }
      if (!done || buf.length - i < len) break;
      this.#handle(buf[pos], buf.subarray(i, i + len));
      pos = i + len;
    }
    this.buf = buf.slice(pos);
  }

  #handle(head, body) {
    const type = head >> 4;
    if (type === 2) {
      if (body[1] !== 0) {
        this.#drop();
        return;
      }
      this.connected = true;
      this.backoff = 800;
      if (this.subs.size) this.#sendSub([...this.subs]);
      this.onChange?.(true);
    } else if (type === 3) {
      const tl = (body[0] << 8) | body[1];
      const topic = td.decode(body.subarray(2, 2 + tl));
      const qos = (head >> 1) & 3;
      this.onMessage?.(topic, body.slice(2 + tl + (qos ? 2 : 0)));
    }
  }
}
