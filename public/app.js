'use strict';

// Must match server/config.js
const CHUNK_SIZE = 16 * 1024;
const HIGH_WATER = 1 * 1024 * 1024;
const LOW_WATER = 256 * 1024;
const UDP_HEADER_SIZE = 12;

const $ = (id) => document.getElementById(id);
const CHUNK = new Uint8Array(CHUNK_SIZE);

const COLORS = { download: '#4f9dff', upload: '#35d0a5', udp: '#f2b03d' };

const state = {
  pc: null,
  ws: null,
  ctrl: null,
  data: null,
  udp: null,
  // ctrl-channel message handlers keyed by message type, set per-test.
  ctrlWaiters: {},
  chartPoints: [], // { test, mbps }
};

// ---- UI helpers ----------------------------------------------------------

function setConn(text, cls) {
  const el = $('conn');
  el.textContent = text;
  el.className = 'badge' + (cls ? ' ' + cls : '');
}
function setPhase(text) {
  $('phase').textContent = text || '';
}
function log(line) {
  const el = $('log');
  el.textContent += line + '\n';
  el.scrollTop = el.scrollHeight;
}
function mbps(bytes, seconds) {
  return seconds > 0 ? (bytes * 8) / seconds / 1e6 : 0;
}
function fmt(n) {
  return Number(n).toFixed(2);
}

// ---- chart ---------------------------------------------------------------

function pushPoint(test, value) {
  state.chartPoints.push({ test, mbps: value });
  drawChart();
}
function drawChart() {
  const c = $('chart');
  const ctx = c.getContext('2d');
  const W = c.width;
  const H = c.height;
  const pad = { l: 48, r: 12, t: 14, b: 24 };
  ctx.clearRect(0, 0, W, H);

  const pts = state.chartPoints;
  const maxV = Math.max(1, ...pts.map((p) => p.mbps));
  const yMax = niceMax(maxV);

  // grid + y labels
  ctx.strokeStyle = '#2a313c';
  ctx.fillStyle = '#9aa7b4';
  ctx.font = '11px system-ui, sans-serif';
  ctx.lineWidth = 1;
  const rows = 4;
  for (let i = 0; i <= rows; i++) {
    const y = pad.t + ((H - pad.t - pad.b) * i) / rows;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(W - pad.r, y);
    ctx.stroke();
    const val = (yMax * (rows - i)) / rows;
    ctx.fillText(val.toFixed(0), 6, y + 4);
  }
  ctx.fillText('Mbps', 6, pad.t - 2);

  if (pts.length === 0) return;

  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const n = Math.max(pts.length - 1, 1);
  const x = (i) => pad.l + (plotW * i) / n;
  const y = (v) => pad.t + plotH * (1 - v / yMax);

  // draw contiguous segments per test so colours don't bleed together
  let i = 0;
  while (i < pts.length) {
    const test = pts[i].test;
    let j = i;
    ctx.beginPath();
    ctx.strokeStyle = COLORS[test] || '#e6edf3';
    ctx.lineWidth = 2;
    while (j < pts.length && pts[j].test === test) {
      const px = x(j);
      const py = y(pts[j].mbps);
      if (j === i) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
      j++;
    }
    ctx.stroke();
    i = j;
  }
}
function niceMax(v) {
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

// ---- WebRTC / signaling --------------------------------------------------

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

async function fetchIceServers() {
  try {
    const r = await fetch('/config');
    const cfg = await r.json();
    if (cfg && Array.isArray(cfg.iceServers) && cfg.iceServers.length) return cfg.iceServers;
  } catch (e) {
    /* fall back below */
  }
  return [{ urls: 'stun:stun.l.google.com:19302' }];
}

function connect() {
  return new Promise(async (resolve, reject) => {
    setConn('連線中…', 'connecting');
    const iceServers = await fetchIceServers();
    const pc = new RTCPeerConnection({ iceServers });
    const ws = new WebSocket(wsUrl());
    state.pc = pc;
    state.ws = ws;

    // Browser is the initiator: create the channels up front.
    state.ctrl = pc.createDataChannel('ctrl', { ordered: true });
    state.data = pc.createDataChannel('data', { ordered: true });
    state.udp = pc.createDataChannel('udp', { ordered: false, maxRetransmits: 0 });
    for (const ch of [state.ctrl, state.data, state.udp]) ch.binaryType = 'arraybuffer';

    state.ctrl.onmessage = (ev) => onCtrl(ev.data);

    pc.onicecandidate = (ev) => {
      if (ev.candidate) ws.send(JSON.stringify({ type: 'candidate', candidate: ev.candidate }));
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') setConn('已連線', 'connected');
      else if (s === 'failed' || s === 'disconnected') setConn('連線失敗', 'failed');
    };

    ws.onopen = async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      ws.send(JSON.stringify({ type: 'offer', sdp: offer.sdp }));
    };
    ws.onmessage = async (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'answer') {
        await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      } else if (msg.type === 'candidate' && msg.candidate) {
        try {
          await pc.addIceCandidate(msg.candidate);
        } catch (e) {
          /* ignore late candidates */
        }
      }
    };
    ws.onerror = () => reject(new Error('signaling websocket error'));

    // Resolve when the control channel is usable.
    state.ctrl.onopen = () => resolve();
    setTimeout(() => reject(new Error('連線逾時')), 15000);
  });
}

function sendCtrl(obj) {
  state.ctrl.send(JSON.stringify(obj));
}

function onCtrl(raw) {
  let m;
  try {
    m = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
  } catch (e) {
    return;
  }
  const key = m.t === 'pong' ? 'pong' : `${m.t}:${m.test || ''}`;
  const waiter = state.ctrlWaiters[key];
  if (waiter) waiter(m);
}

// Register a one-shot or streaming ctrl handler.
function onCtrlType(key, fn) {
  state.ctrlWaiters[key] = fn;
}
function offCtrlType(key) {
  delete state.ctrlWaiters[key];
}

// ---- shared sender loop (flow-controlled) --------------------------------

function blast(channel, durationMs, fill) {
  return new Promise((resolve) => {
    channel.bufferedAmountLowThreshold = LOW_WATER;
    const start = performance.now();
    let sent = 0;

    const pump = () => {
      if (channel.readyState !== 'open') return resolve(sent);
      while (performance.now() - start < durationMs) {
        if (channel.bufferedAmount > HIGH_WATER) {
          channel.onbufferedamountlow = () => {
            channel.onbufferedamountlow = null;
            pump();
          };
          return;
        }
        const chunk = fill ? fill() : CHUNK;
        channel.send(chunk);
        sent += chunk.byteLength;
      }
      resolve(sent);
    };
    pump();
  });
}

// ---- tests ---------------------------------------------------------------

async function testLatency() {
  setPhase('測試延遲…');
  const rtts = [];
  const N = 20;
  for (let seq = 0; seq < N; seq++) {
    const rtt = await new Promise((resolve) => {
      const t0 = performance.now();
      onCtrlType('pong', (m) => {
        if (m.seq === seq) {
          offCtrlType('pong');
          resolve(performance.now() - t0);
        }
      });
      sendCtrl({ t: 'ping', seq, ts: t0 });
      setTimeout(() => resolve(NaN), 2000);
    });
    if (!Number.isNaN(rtt)) rtts.push(rtt);
    await sleep(40);
  }
  offCtrlType('pong');
  if (rtts.length === 0) {
    log('latency: 無回應');
    return;
  }
  const min = Math.min(...rtts);
  const max = Math.max(...rtts);
  const avg = rtts.reduce((a, b) => a + b, 0) / rtts.length;
  let jitter = 0;
  for (let i = 1; i < rtts.length; i++) jitter += Math.abs(rtts[i] - rtts[i - 1]);
  jitter = rtts.length > 1 ? jitter / (rtts.length - 1) : 0;
  $('latency-val').textContent = fmt(avg);
  $('jitter-val').textContent = fmt(jitter);
  log(`latency: min/avg/max = ${fmt(min)}/${fmt(avg)}/${fmt(max)} ms, jitter ${fmt(jitter)} ms (${rtts.length} pings)`);
}

async function testDownload(duration) {
  setPhase('測試下載…');
  return receiveThroughput('download', state.data, duration, () => {
    sendCtrl({ t: 'start', test: 'download', duration });
  });
}

async function testUpload(duration) {
  setPhase('測試上傳…');
  // Server is the receiver; it streams back interval + summary reports.
  const intervals = [];
  onCtrlType('interval:upload', (m) => {
    intervals.push(m.mbps);
    pushPoint('upload', m.mbps);
    log(`[upload] ${intervals.length}s  ${fmt(m.mbps)} Mbps`);
  });
  const summary = new Promise((resolve) => {
    onCtrlType('summary:upload', (m) => {
      offCtrlType('interval:upload');
      offCtrlType('summary:upload');
      resolve(m);
    });
  });

  sendCtrl({ t: 'begin', test: 'upload' });
  await blast(state.data, duration * 1000);
  sendCtrl({ t: 'end', test: 'upload' });

  const m = await Promise.race([summary, sleep(4000).then(() => null)]);
  if (m) {
    $('upload-val').textContent = fmt(m.mbps);
    log(`upload: ${fmt(m.mbps)} Mbps (${fmt(m.bytes / 1e6)} MB in ${fmt(m.seconds)} s)`);
  } else {
    log('upload: 未收到伺服器總結');
  }
}

async function testUdp(duration) {
  setPhase('測試 UDP 丟包 / jitter…');
  let received = 0;
  let bytes = 0;
  let maxSeq = -1;
  let jitter = 0;
  let lastTransit = null;
  const start = performance.now();
  let lastTick = start;
  let bytesThisSec = 0;

  const done = new Promise((resolve) => {
    onCtrlType('done:udp', (m) => {
      offCtrlType('done:udp');
      resolve(m.sent);
    });
  });

  state.udp.onmessage = (ev) => {
    const buf = ev.data;
    if (!(buf instanceof ArrayBuffer) || buf.byteLength < UDP_HEADER_SIZE) return;
    const view = new DataView(buf);
    const seq = view.getUint32(0);
    const sendTs = view.getFloat64(4);
    received++;
    bytes += buf.byteLength;
    bytesThisSec += buf.byteLength;
    if (seq > maxSeq) maxSeq = seq;
    // RFC3550-style jitter on (arrival - sendTs); constant clock offset cancels.
    const transit = Date.now() - sendTs;
    if (lastTransit !== null) {
      const d = Math.abs(transit - lastTransit);
      jitter += (d - jitter) / 16;
    }
    lastTransit = transit;

    const now = performance.now();
    if (now - lastTick >= 1000) {
      const secs = (now - lastTick) / 1000;
      const rate = mbps(bytesThisSec, secs);
      pushPoint('udp', rate);
      log(`[udp] ${Math.round((now - start) / 1000)}s  ${fmt(rate)} Mbps`);
      lastTick = now;
      bytesThisSec = 0;
    }
  };

  sendCtrl({ t: 'start', test: 'udp', duration });
  const sent = await done;
  await sleep(200); // let stragglers arrive
  state.udp.onmessage = null;

  const seconds = (performance.now() - start) / 1000;
  const rate = mbps(bytes, seconds);
  const loss = sent > 0 ? Math.max(0, (1 - received / sent) * 100) : 0;
  $('loss-val').textContent = fmt(loss);
  // don't overwrite the latency-based jitter unless UDP produced a value
  if (received > 1) $('jitter-val').textContent = fmt(jitter);
  log(
    `udp: ${fmt(rate)} Mbps, 收到 ${received}/${sent} 個封包, 丟包 ${fmt(loss)}%, jitter ${fmt(jitter)} ms`
  );
}

// Generic receiver-side throughput measurement for server->browser tests.
function receiveThroughput(name, channel, duration, kick) {
  return new Promise((resolve) => {
    let bytes = 0;
    let bytesThisSec = 0;
    const start = performance.now();
    let lastTick = start;

    const tick = setInterval(() => {
      const now = performance.now();
      const secs = (now - lastTick) / 1000;
      const rate = mbps(bytesThisSec, secs);
      pushPoint(name, rate);
      log(`[${name}] ${Math.round((now - start) / 1000)}s  ${fmt(rate)} Mbps`);
      lastTick = now;
      bytesThisSec = 0;
    }, 1000);

    channel.onmessage = (ev) => {
      const len = ev.data.byteLength || ev.data.length || 0;
      bytes += len;
      bytesThisSec += len;
    };

    onCtrlType(`done:${name}`, () => {
      offCtrlType(`done:${name}`);
      clearInterval(tick);
      channel.onmessage = null;
      const seconds = (performance.now() - start) / 1000;
      const rate = mbps(bytes, seconds);
      $(`${name}-val`).textContent = fmt(rate);
      log(`${name}: ${fmt(rate)} Mbps (${fmt(bytes / 1e6)} MB in ${fmt(seconds)} s)`);
      resolve();
    });

    kick();
  });
}

// ---- orchestration -------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runAll() {
  const duration = Number($('duration').value);
  $('start').disabled = true;
  state.chartPoints = [];
  drawChart();
  ['download', 'upload', 'latency', 'jitter', 'loss'].forEach((k) => ($(`${k}-val`).textContent = '—'));

  try {
    if (!state.ctrl || state.ctrl.readyState !== 'open') {
      await connect();
    }
    if ($('t-latency').checked) await testLatency();
    if ($('t-download').checked) await testDownload(duration);
    if ($('t-upload').checked) await testUpload(duration);
    if ($('t-udp').checked) await testUdp(duration);
    setPhase('完成 ✓');
  } catch (e) {
    setPhase('錯誤：' + e.message);
    setConn('連線失敗', 'failed');
    log('error: ' + e.message);
  } finally {
    $('start').disabled = false;
  }
}

$('start').addEventListener('click', runAll);
$('clear-log').addEventListener('click', () => ($('log').textContent = ''));
drawChart();
