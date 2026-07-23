// WebRTC signaling + the throughput/latency/loss test protocol + canvas chart.
//
// This is the same logic that was verified end-to-end before the React
// migration; it operates on an explicit `ctx` object (WebRTC objects + React
// setState callbacks) so the measurement code stays free of any UI framework.

// Must match server/config.js
const CHUNK_SIZE = 16 * 1024;
const HIGH_WATER = 1 * 1024 * 1024;
const LOW_WATER = 256 * 1024;
const UDP_HEADER_SIZE = 12;
const CHUNK = new Uint8Array(CHUNK_SIZE);

export const COLORS = { download: '#4f9dff', upload: '#35d0a5', udp: '#f2b03d' };

function mbps(bytes, seconds) {
  return seconds > 0 ? (bytes * 8) / seconds / 1e6 : 0;
}
function fmt(n) {
  return Number(n).toFixed(2);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function niceMax(v) {
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

// ---- chart: plain canvas drawing ------------------------------------------

export function drawChart(canvas, points) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const pad = { l: 48, r: 12, t: 14, b: 24 };
  ctx.clearRect(0, 0, W, H);

  const maxV = Math.max(1, ...points.map((p) => p.mbps));
  const yMax = niceMax(maxV);

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

  if (points.length === 0) return;

  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const n = Math.max(points.length - 1, 1);
  const x = (i) => pad.l + (plotW * i) / n;
  const y = (v) => pad.t + plotH * (1 - v / yMax);

  // draw contiguous segments per test so colours don't bleed together
  let i = 0;
  while (i < points.length) {
    const test = points[i].test;
    let j = i;
    ctx.beginPath();
    ctx.strokeStyle = COLORS[test] || '#e6edf3';
    ctx.lineWidth = 2;
    while (j < points.length && points[j].test === test) {
      const px = x(j);
      const py = y(points[j].mbps);
      if (j === i) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
      j++;
    }
    ctx.stroke();
    i = j;
  }
}

// ---- WebRTC / signaling ---------------------------------------------------

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

async function fetchIceServers() {
  try {
    const r = await fetch('/config');
    const cfg = await r.json();
    // The server is authoritative — an empty list is valid (LAN / offline
    // mode: connect using host candidates only, no STUN/TURN).
    if (cfg && Array.isArray(cfg.iceServers)) return cfg.iceServers;
  } catch (e) {
    /* fall back below only if the request itself failed */
  }
  return [{ urls: 'stun:stun.l.google.com:19302' }];
}

export function connect(ctx) {
  return new Promise((resolve, reject) => {
    ctx.setConn('連線中…', 'connecting');
    fetchIceServers().then((iceServers) => {
      const pc = new RTCPeerConnection({ iceServers });
      const ws = new WebSocket(wsUrl());
      ctx.pc = pc;
      ctx.ws = ws;
      // Stashed so diagnostics can tell "no STUN configured" (LAN_ONLY) apart
      // from "STUN configured but no server responded".
      ctx.iceServers = iceServers;

      // Browser is the initiator: create the channels up front.
      ctx.ctrl = pc.createDataChannel('ctrl', { ordered: true });
      ctx.data = pc.createDataChannel('data', { ordered: true });
      ctx.udp = pc.createDataChannel('udp', { ordered: false, maxRetransmits: 0 });
      for (const ch of [ctx.ctrl, ctx.data, ctx.udp]) ch.binaryType = 'arraybuffer';

      ctx.ctrl.onmessage = (ev) => onCtrl(ctx, ev.data);

      pc.onicecandidate = (ev) => {
        if (ev.candidate) ws.send(JSON.stringify({ type: 'candidate', candidate: ev.candidate }));
      };
      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === 'connected') ctx.setConn('已連線', 'connected');
        else if (s === 'failed' || s === 'disconnected') ctx.setConn('連線失敗', 'failed');
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
      ctx.ctrl.onopen = () => resolve();
      setTimeout(() => reject(new Error('連線逾時')), 15000);
    });
  });
}

function sendCtrl(ctx, obj) {
  ctx.ctrl.send(JSON.stringify(obj));
}

function onCtrl(ctx, raw) {
  let m;
  try {
    m = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
  } catch (e) {
    return;
  }
  const key = m.t === 'pong' ? 'pong' : `${m.t}:${m.test || ''}`;
  const waiter = ctx.ctrlWaiters[key];
  if (waiter) waiter(m);
}

// Register a one-shot or streaming ctrl handler.
function onCtrlType(ctx, key, fn) {
  ctx.ctrlWaiters[key] = fn;
}
function offCtrlType(ctx, key) {
  delete ctx.ctrlWaiters[key];
}

// ---- shared sender loop (flow-controlled) ---------------------------------

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

// ---- tests ----------------------------------------------------------------

async function testLatency(ctx) {
  ctx.setPhase('測試延遲…');
  const rtts = [];
  const N = 20;
  for (let seq = 0; seq < N; seq++) {
    const rtt = await new Promise((resolve) => {
      const t0 = performance.now();
      onCtrlType(ctx, 'pong', (m) => {
        if (m.seq === seq) {
          offCtrlType(ctx, 'pong');
          resolve(performance.now() - t0);
        }
      });
      sendCtrl(ctx, { t: 'ping', seq, ts: t0 });
      setTimeout(() => resolve(NaN), 2000);
    });
    if (!Number.isNaN(rtt)) rtts.push(rtt);
    await sleep(40);
  }
  offCtrlType(ctx, 'pong');
  if (rtts.length === 0) {
    ctx.pushLog('latency: 無回應');
    return;
  }
  const min = Math.min(...rtts);
  const max = Math.max(...rtts);
  const avg = rtts.reduce((a, b) => a + b, 0) / rtts.length;
  let jitter = 0;
  for (let i = 1; i < rtts.length; i++) jitter += Math.abs(rtts[i] - rtts[i - 1]);
  jitter = rtts.length > 1 ? jitter / (rtts.length - 1) : 0;
  ctx.setMetric('latency', fmt(avg));
  ctx.setMetric('jitter', fmt(jitter));
  ctx.pushLog(
    `latency: min/avg/max = ${fmt(min)}/${fmt(avg)}/${fmt(max)} ms, jitter ${fmt(jitter)} ms (${rtts.length} pings)`
  );
}

async function testDownload(ctx, duration) {
  ctx.setPhase('測試下載…');
  return receiveThroughput(ctx, 'download', ctx.data, duration, () => {
    sendCtrl(ctx, { t: 'start', test: 'download', duration });
  });
}

async function testUpload(ctx, duration) {
  ctx.setPhase('測試上傳…');
  // Server is the receiver; it streams back interval + summary reports.
  let intervalCount = 0;
  onCtrlType(ctx, 'interval:upload', (m) => {
    intervalCount++;
    ctx.pushPoint('upload', m.mbps);
    ctx.pushLog(`[upload] ${intervalCount}s  ${fmt(m.mbps)} Mbps`);
  });
  const summary = new Promise((resolve) => {
    onCtrlType(ctx, 'summary:upload', (m) => {
      offCtrlType(ctx, 'interval:upload');
      offCtrlType(ctx, 'summary:upload');
      resolve(m);
    });
  });

  sendCtrl(ctx, { t: 'begin', test: 'upload' });
  const sent = await blast(ctx.data, duration * 1000);
  // Tell the server exactly how many bytes to expect so it can wait for the
  // in-flight tail before computing the summary.
  sendCtrl(ctx, { t: 'end', test: 'upload', bytes: sent });

  const m = await Promise.race([summary, sleep(6000).then(() => null)]);
  if (m) {
    ctx.setMetric('upload', fmt(m.mbps));
    ctx.pushLog(`upload: ${fmt(m.mbps)} Mbps (${fmt(m.bytes / 1e6)} MB in ${fmt(m.seconds)} s)`);
  } else {
    ctx.pushLog('upload: 未收到伺服器總結');
  }
}

async function testUdp(ctx, duration) {
  ctx.setPhase('測試 UDP 丟包 / jitter…');
  let received = 0;
  let bytes = 0;
  let maxSeq = -1;
  let jitter = 0;
  let lastTransit = null;
  let start = 0; // set on first packet
  let last = 0;
  let lastTick = 0;
  let bytesThisSec = 0;

  const done = new Promise((resolve) => {
    onCtrlType(ctx, 'done:udp', (m) => {
      offCtrlType(ctx, 'done:udp');
      resolve(m.sent);
    });
  });

  ctx.udp.onmessage = (ev) => {
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
    if (!start) {
      start = now;
      lastTick = now;
    }
    last = now;
    if (now - lastTick >= 1000) {
      const secs = (now - lastTick) / 1000;
      const rate = mbps(bytesThisSec, secs);
      ctx.pushPoint('udp', rate);
      ctx.pushLog(`[udp] ${Math.round((now - start) / 1000)}s  ${fmt(rate)} Mbps`);
      lastTick = now;
      bytesThisSec = 0;
    }
  };

  sendCtrl(ctx, { t: 'start', test: 'udp', duration });
  const sent = await done;
  await sleep(300); // let unreliable-channel stragglers arrive
  ctx.udp.onmessage = null;

  const seconds = start ? (last - start) / 1000 : 0;
  const rate = mbps(bytes, seconds);
  const loss = sent > 0 ? Math.max(0, (1 - received / sent) * 100) : 0;
  ctx.setMetric('loss', fmt(loss));
  // don't overwrite the latency-based jitter unless UDP produced a value
  if (received > 1) ctx.setMetric('jitter', fmt(jitter));
  ctx.pushLog(
    `udp: ${fmt(rate)} Mbps, 收到 ${received}/${sent} 個封包, 丟包 ${fmt(loss)}%, jitter ${fmt(jitter)} ms`
  );
}

// Generic receiver-side throughput measurement for server->browser tests.
function receiveThroughput(ctx, name, channel, duration, kick) {
  return new Promise((resolve) => {
    let bytes = 0;
    let bytesThisSec = 0;
    let start = 0; // set on first byte (excludes signaling latency)
    let last = 0;
    let lastTick = 0;
    let expected = null; // total bytes the server says it sent
    let done = false;

    const tick = setInterval(() => {
      if (!start) return;
      const now = performance.now();
      const secs = (now - lastTick) / 1000;
      const rate = mbps(bytesThisSec, secs);
      ctx.pushPoint(name, rate);
      ctx.pushLog(`[${name}] ${Math.round((now - start) / 1000)}s  ${fmt(rate)} Mbps`);
      lastTick = now;
      bytesThisSec = 0;
    }, 1000);

    const finalize = () => {
      if (done) return;
      done = true;
      clearInterval(tick);
      channel.onmessage = null;
      offCtrlType(ctx, `done:${name}`);
      const seconds = (last - start) / 1000;
      const rate = mbps(bytes, seconds);
      ctx.setMetric(name, fmt(rate));
      ctx.pushLog(`${name}: ${fmt(rate)} Mbps (${fmt(bytes / 1e6)} MB in ${fmt(seconds)} s)`);
      resolve();
    };

    channel.onmessage = (ev) => {
      const len = ev.data.byteLength || ev.data.length || 0;
      const now = performance.now();
      if (!start) {
        start = now;
        lastTick = now;
      }
      last = now;
      bytes += len;
      bytesThisSec += len;
      // The 'done' marker can arrive before the last data bytes; finalize only
      // once every reported byte has landed.
      if (expected !== null && bytes >= expected) finalize();
    };

    onCtrlType(ctx, `done:${name}`, (m) => {
      expected = typeof m.bytes === 'number' ? m.bytes : 0;
      if (bytes >= expected) finalize();
      // Safety net in case a byte count never quite matches (shouldn't happen
      // on a reliable channel): finalize shortly after the marker.
      else setTimeout(finalize, 3000);
    });

    kick();
  });
}

// ---- orchestration --------------------------------------------------------

export async function runAll(ctx, duration, tests) {
  ctx.setRunning(true);
  ctx.resetChart();
  ctx.resetMetrics();
  try {
    if (!ctx.ctrl || ctx.ctrl.readyState !== 'open') {
      await connect(ctx);
    }
    if (tests.latency) await testLatency(ctx);
    if (tests.download) await testDownload(ctx, duration);
    if (tests.upload) await testUpload(ctx, duration);
    if (tests.udp) await testUdp(ctx, duration);
    ctx.setPhase('完成 ✓');
  } catch (e) {
    ctx.setPhase('錯誤：' + e.message);
    ctx.setConn('連線失敗', 'failed');
    ctx.pushLog('error: ' + e.message);
  } finally {
    ctx.setRunning(false);
  }
}

// Diagnostics: the selected ICE candidate pair (host / srflx / relay + address)
// the test actually ran over. Useful for debugging LAN vs relay connectivity.
export async function selectedPath(pc) {
  if (!pc) return null;
  const stats = await pc.getStats();
  let pair = null;
  stats.forEach((r) => {
    if (r.type === 'candidate-pair' && (r.selected || r.state === 'succeeded' || r.nominated)) pair = r;
  });
  if (!pair) return null;
  const local = stats.get(pair.localCandidateId);
  const remote = stats.get(pair.remoteCandidateId);
  const fmtC = (c) => (c ? `${c.candidateType} ${c.address || c.ip}:${c.port}/${c.protocol}` : '?');
  return { local: fmtC(local), remote: fmtC(remote), state: pair.state };
}
