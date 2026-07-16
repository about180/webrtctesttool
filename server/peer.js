'use strict';

const {
  CHUNK_SIZE,
  HIGH_WATER,
  LOW_WATER,
  UDP_HEADER_SIZE,
  CH_CTRL,
  CH_DATA,
  CH_UDP,
} = require('./config');

// A pre-allocated payload buffer reused for every send (contents don't matter).
const PAYLOAD = Buffer.alloc(CHUNK_SIZE);

/**
 * Saturate `channel` with binary chunks for `durationMs`, respecting the
 * DataChannel send buffer via bufferedAmount / bufferedAmountLow.
 *
 * `fill(chunk)` optionally stamps per-chunk metadata (used by the udp test).
 * Resolves with the total number of bytes handed to send().
 */
function blast(channel, durationMs, fill) {
  return new Promise((resolve) => {
    channel.bufferedAmountLowThreshold = LOW_WATER;
    const start = Date.now();
    let sent = 0;

    const pump = () => {
      if (channel.readyState !== 'open') return resolve(sent);
      while (Date.now() - start < durationMs) {
        if (channel.bufferedAmount > HIGH_WATER) {
          // Buffer full: yield and resume when it drains below LOW_WATER.
          const sub = channel.bufferedAmountLow.subscribe(() => {
            sub.unSubscribe();
            pump();
          });
          return;
        }
        const chunk = fill ? fill(PAYLOAD) : PAYLOAD;
        channel.send(chunk);
        sent += chunk.length;
      }
      resolve(sent);
    };

    pump();
  });
}

/**
 * Wire up the server side of one browser session once its DataChannels are open.
 * The browser is the initiator; here we only respond.
 */
class Session {
  constructor(log) {
    this.log = log;
    this.ctrl = null;
    this.data = null;
    this.udp = null;
    // Upload measurement state (server is the receiver).
    this.upload = null;
  }

  attachChannel(channel) {
    switch (channel.label) {
      case CH_CTRL:
        this.ctrl = channel;
        channel.onMessage.subscribe((msg) => this.onCtrl(msg));
        break;
      case CH_DATA:
        this.data = channel;
        channel.onMessage.subscribe((msg) => this.onDataBytes(msg));
        break;
      case CH_UDP:
        this.udp = channel;
        // Server only sends on udp (udp-download test); ignore inbound.
        break;
      default:
        this.log(`ignoring unknown channel "${channel.label}"`);
    }
  }

  send(obj) {
    if (this.ctrl && this.ctrl.readyState === 'open') {
      this.ctrl.send(JSON.stringify(obj));
    }
  }

  // ---- control-channel protocol ------------------------------------------

  onCtrl(raw) {
    let m;
    try {
      m = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw);
    } catch (e) {
      return;
    }

    switch (m.t) {
      case 'ping':
        // Echo straight back so the browser can compute RTT.
        this.send({ t: 'pong', seq: m.seq, ts: m.ts });
        break;

      case 'start': // server-as-sender tests
        if (m.test === 'download') this.runDownload(m.duration);
        else if (m.test === 'udp') this.runUdpDownload(m.duration);
        break;

      case 'begin': // browser-as-sender test (upload) is about to start
        if (m.test === 'upload') this.beginUpload();
        break;

      case 'end':
        if (m.test === 'upload') this.endUpload();
        break;

      default:
        break;
    }
  }

  // ---- download: server -> browser on the reliable data channel ----------

  async runDownload(durationSec) {
    const ms = clampDuration(durationSec) * 1000;
    this.log(`download: sending for ${ms / 1000}s`);
    await blast(this.data, ms);
    this.send({ t: 'done', test: 'download' });
  }

  // ---- upload: browser -> server on the reliable data channel ------------

  beginUpload() {
    this.upload = { bytes: 0, start: Date.now(), lastBytes: 0, lastTs: Date.now() };
    this.log('upload: receiving');
    this.upload.timer = setInterval(() => {
      const u = this.upload;
      if (!u) return;
      const now = Date.now();
      const secs = (now - u.lastTs) / 1000;
      const mbps = secs > 0 ? ((u.bytes - u.lastBytes) * 8) / secs / 1e6 : 0;
      this.send({ t: 'interval', test: 'upload', mbps: round(mbps) });
      u.lastBytes = u.bytes;
      u.lastTs = now;
    }, 1000);
  }

  onDataBytes(msg) {
    if (!this.upload) return; // only counted during an active upload test
    this.upload.bytes += msg.length || msg.byteLength || 0;
  }

  endUpload() {
    const u = this.upload;
    if (!u) return;
    clearInterval(u.timer);
    const seconds = (Date.now() - u.start) / 1000;
    const mbps = seconds > 0 ? (u.bytes * 8) / seconds / 1e6 : 0;
    this.send({
      t: 'summary',
      test: 'upload',
      mbps: round(mbps),
      bytes: u.bytes,
      seconds: round(seconds),
    });
    this.log(`upload: ${round(mbps)} Mbps over ${round(seconds)}s`);
    this.upload = null;
  }

  // ---- udp-like download: unreliable, seq-tagged -------------------------

  async runUdpDownload(durationSec) {
    const ms = clampDuration(durationSec) * 1000;
    this.log(`udp: sending seq-tagged chunks for ${ms / 1000}s`);
    let seq = 0;
    await blast(this.udp, ms, (buf) => {
      buf.writeUInt32BE(seq >>> 0, 0);
      buf.writeDoubleBE(Date.now(), 4);
      seq += 1;
      return buf;
    });
    // Tell the browser how many datagrams we emitted so it can compute loss.
    this.send({ t: 'done', test: 'udp', sent: seq });
  }
}

function clampDuration(sec) {
  const n = Number(sec) || 10;
  return Math.min(60, Math.max(1, n));
}

function round(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { Session };
