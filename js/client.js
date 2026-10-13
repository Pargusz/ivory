// Odaya katılan oyuncunun tarafı. Host'un yayınladığı son durumu tutar; kendi mesajlarını
// (selam, kütüphane, oy, devam) host onaylayana kadar tekrar yollar. Hiçbir adım tek bir
// mesajın ulaşmasına bağlı değildir.

const HELLO_MS = 3000;
const RESEND_MS = 1200;
const LIB_RETRY_MS = 6000;
const HOST_SILENCE_MS = 9000;

export class ClientSession {
  constructor({ me, chunks, rev, count, send, onState, onGone }) {
    this.me = me;
    this.chunks = chunks;
    this.rev = rev;
    this.count = count;
    this.send = send;
    this.onState = onState;
    this.onGone = onGone;
    this.state = null;
    this.off = 0;
    this.lastHello = 0;
    this.lastState = 0;
    this.libQueue = [];
    this.libSentAt = 0;
    this.pendingVote = null;
    this.pendingCont = null;
    this.gone = false;
  }

  setLib(chunks, rev, count) {
    this.chunks = chunks;
    this.rev = rev;
    this.count = count;
    this.libQueue = [];
    this.libSentAt = 0;
    this.poke();
  }

  get hostAlive() {
    return !!this.state && Date.now() - this.lastState < HOST_SILENCE_MS;
  }

  poke() {
    this.lastHello = 0;
  }

  receive(m) {
    if (this.gone) return;
    if (m.t === 'x') {
      if (!m.to || m.to === this.me.id) {
        this.gone = true;
        this.onGone(m.why);
      }
      return;
    }
    if (m.t !== 'st') return;
    const cur = this.state;
    if (cur) {
      if (m.inst === cur.inst ? m.v <= cur.v : m.since < cur.since) return;
    }
    // Gecikme farkı her zaman saati geri gösterir; en büyük örnek en doğrusudur.
    const sample = m.now - Date.now();
    this.off = cur && cur.inst === m.inst ? Math.max(this.off, sample) : sample;
    this.state = m;
    this.lastState = Date.now();
    this.onState(m);
  }

  vote(round, ballot) {
    this.pendingVote = { r: round, b: ballot, at: Date.now() };
    this.send({ t: 'v', r: round, b: ballot });
  }

  cont(round) {
    this.pendingCont = { r: round, at: Date.now() };
    this.send({ t: 'c', r: round });
  }

  saved() {
    this.send({ t: 'sv' });
  }

  react(e) {
    this.send({ t: 'rx', e });
  }

  leave() {
    this.gone = true;
    this.send({ t: 'bye' });
  }

  tick(now) {
    if (this.gone) return;
    if (now - this.lastHello >= HELLO_MS) {
      this.lastHello = now;
      this.send({ t: 'hi', name: this.me.name, mode: this.me.mode, n: this.count, lt: this.chunks.length, lr: this.rev });
    }
    const st = this.state;
    const mine = st?.pl.find((p) => p.id === this.me.id);
    if (!mine) return;

    if (!mine.ok && !this.libQueue.length && now - this.libSentAt > LIB_RETRY_MS) {
      this.libQueue = this.chunks.map((_, i) => i);
      this.libSentAt = now;
    }
    for (let k = 0; k < 2 && this.libQueue.length; k++) {
      const i = this.libQueue.shift();
      this.send({ t: 'lib', r: this.rev, i, n: this.chunks.length, d: this.chunks[i] });
      this.libSentAt = now;
    }

    const rd = st.rd;
    const v = this.pendingVote;
    if (v) {
      if (!rd || rd.n !== v.r || st.phase !== 'vote' || rd.voted.includes(this.me.id)) this.pendingVote = null;
      else if (now - v.at > RESEND_MS) {
        v.at = now;
        this.send({ t: 'v', r: v.r, b: v.b });
      }
    }
    const c = this.pendingCont;
    if (c) {
      if (!rd || rd.n !== c.r || st.phase !== 'reveal' || rd.cont.includes(this.me.id)) this.pendingCont = null;
      else if (now - c.at > RESEND_MS) {
        c.at = now;
        this.send({ t: 'c', r: c.r });
      }
    }
  }
}
