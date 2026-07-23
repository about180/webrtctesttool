// ICE / STUN / NAT diagnostics: reuses the same connection machinery as
// net.js's throughput tests (connecting if needed, or reusing an already-open
// connection), then reads the browser's own RTCPeerConnection.getStats() to
// surface exactly what WebRTC actually negotiated — candidate types, STUN
// bindings, the full local/remote candidate lists, and every candidate pair
// tried, not just the winner.
import { connect } from './net.js';

// Waits for ICE gathering to finish (bounded by timeoutMs) so the candidate
// lists below are as complete as possible. connect() only waits for the
// control channel to open, which can happen before gathering fully completes
// with trickle ICE.
export function waitIceGatheringComplete(pc, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const timer = setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    }, timeoutMs);
    function onChange() {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', onChange);
        resolve();
      }
    }
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

// Probe every configured STUN server on a *dedicated* RTCPeerConnection that
// connects to no peer. This matters: the main test connection completes its
// host-host candidate pair almost instantly (especially on a LAN), and the
// browser then curtails STUN gathering — so reading srflx off the main
// connection is unreliable/incomplete. A gather-only connection has nothing to
// connect to, so gathering runs fully and queries every STUN server. All
// servers share the same local candidate base here, which is exactly what
// makes the mapped-port comparison a valid Cone-vs-Symmetric signal.
export async function gatherStunBindings(iceServers, timeoutMs = 5000) {
  const stunServers = (iceServers || []).filter((s) => /^stuns?:/.test(String(s.urls)));
  if (stunServers.length === 0) return { srflx: [], hostAddresses: new Set(), errors: [], stunUrls: [] };

  const pc = new RTCPeerConnection({ iceServers: stunServers });
  const errors = [];
  pc.addEventListener('icecandidateerror', (e) => errors.push({ url: e.url, errorCode: e.errorCode }));
  try {
    pc.createDataChannel('stun-probe'); // an m-line so gathering starts
    await pc.setLocalDescription(await pc.createOffer());
    await waitIceGatheringComplete(pc, timeoutMs);

    const stats = await pc.getStats();
    const srflx = [];
    const hostAddresses = new Set();
    stats.forEach((r) => {
      if (r.type !== 'local-candidate') return;
      if (r.candidateType === 'srflx' && r.url) {
        srflx.push({ url: r.url, address: r.address, port: r.port });
      } else if (r.candidateType === 'host' && r.address) {
        hostAddresses.add(r.address);
      }
    });
    return { srflx, hostAddresses, errors, stunUrls: stunServers.map((s) => s.urls) };
  } finally {
    try { pc.close(); } catch (e) { /* ignore */ }
  }
}

function normalizeCandidate(r) {
  return {
    id: r.id,
    type: r.candidateType || '?', // host | srflx | prflx | relay
    protocol: r.protocol || '?',
    address: r.address || r.ip || '?',
    port: typeof r.port === 'number' ? r.port : null,
    priority: r.priority,
    foundation: r.foundation || null,
    relatedAddress: r.relatedAddress || null,
    relatedPort: typeof r.relatedPort === 'number' ? r.relatedPort : null,
    // The STUN/TURN server URL that produced this candidate (only set for
    // srflx/relay candidates gathered via a configured ICE server).
    url: r.url || null,
    networkType: r.networkType || null,
  };
}

// icecandidateerror.errorCode >= 700 means no STUN response was received at all
// (timeout / unreachable); 300–699 means the server *did* reply, just with an
// error. So a >=700 code is the signal that a server genuinely didn't answer.
const STUN_NO_RESPONSE_CODE = 700;

// Approximate NAT-type classification. This is NOT the full RFC 3489
// Full/Restricted/Port-Restricted Cone vs Symmetric taxonomy — that requires
// a STUN server supporting CHANGE-REQUEST (RFC 5780), which public STUN
// servers no longer offer, and a browser can't send raw STUN packets to a
// self-hosted one anyway. Instead it uses ONE RTCPeerConnection carrying every
// configured STUN server (so all queries share the same local candidate base,
// which is what makes the comparison valid) and compares the externally-mapped
// port each server reports.
//
// `stunResults` is one entry per configured STUN server:
//   { ok: true,  port }              -> produced a srflx binding
//   { ok: false, timedOut: true }    -> errorCode >= 700 (no response)
//   { ok: false, timedOut: false }   -> no binding and no timeout error; it may
//                                       have answered with the SAME mapping as
//                                       another server and been deduplicated
//                                       (RFC 8445 §5.1.3), so we can't be sure.
//
// A responding server always produces a binding UNLESS it was deduped against
// an identical mapping — which only happens when ports match (Cone). So distinct
// ports across bindings can't be hidden by dedup: >=2 distinct ports is a
// definitive Symmetric signal.
function classifyNatType(hostAddresses, stunResults) {
  if (stunResults.length === 0) {
    return { kind: 'na', label: 'N/A (LAN_ONLY, no STUN configured)' };
  }

  const bindings = stunResults.filter((r) => r.ok);
  if (bindings.length === 0) {
    return { kind: 'unknown', label: 'Undetermined (STUN timed out or UDP blocked)' };
  }

  if (bindings.some((b) => hostAddresses.has(b.address))) {
    return { kind: 'open', label: 'Public IP / no NAT' };
  }

  const distinctPorts = new Set(bindings.map((b) => b.port));
  if (distinctPorts.size >= 2) {
    return { kind: 'symmetric', label: 'Symmetric NAT (address-dependent mapping)' };
  }

  // Exactly one external port observed. It's Cone only if a second server also
  // participated (either its own binding, or it answered but was deduped —
  // i.e. it did NOT time out). Servers that timed out don't count.
  const participating = stunResults.filter((r) => r.ok || !r.timedOut).length;
  if (participating >= 2) {
    return { kind: 'cone', label: 'Cone-type NAT (predictable mapping)' };
  }
  const label =
    stunResults.length < 2
      ? 'Insufficient samples (only 1 STUN configured; need ≥2 to compare — set STUN_URLS)'
      : `Insufficient samples (only ${bindings.length} STUN server(s) responded, the rest timed out; need ≥2 to compare)`;
  return { kind: 'insufficient', label };
}

export async function runDiagnostics(ctx) {
  ctx.diagSetStatus('running');
  ctx.diagSetError(null);
  try {
    if (!ctx.ctrl || ctx.ctrl.readyState !== 'open') {
      await connect(ctx);
    }
    // Run the dedicated STUN probe in parallel with waiting for the main
    // connection's gathering, so the two bounded waits overlap instead of
    // adding up.
    const [, probe] = await Promise.all([
      waitIceGatheringComplete(ctx.pc, 5000),
      gatherStunBindings(ctx.iceServers),
    ]);
    const stats = await ctx.pc.getStats();

    const localCandidates = [];
    const remoteCandidates = [];
    const candidateById = new Map();
    const pairsRaw = [];

    stats.forEach((r) => {
      if (r.type === 'local-candidate') {
        const c = normalizeCandidate(r);
        localCandidates.push(c);
        candidateById.set(r.id, c);
      } else if (r.type === 'remote-candidate') {
        const c = normalizeCandidate(r);
        remoteCandidates.push(c);
        candidateById.set(r.id, c);
      } else if (r.type === 'candidate-pair') {
        pairsRaw.push(r);
      }
    });

    const pairs = pairsRaw.map((p) => {
      const local = candidateById.get(p.localCandidateId);
      const remote = candidateById.get(p.remoteCandidateId);
      return {
        localAddr: local ? local.address : '?',
        localPort: local ? local.port : '?',
        remoteAddr: remote ? remote.address : '?',
        remotePort: remote ? remote.port : '?',
        state: p.state,
        nominated: !!p.nominated,
        priority: p.priority,
        rtt: typeof p.currentRoundTripTime === 'number' ? Math.round(p.currentRoundTripTime * 1000) : null,
      };
    });

    // STUN bindings / NAT type come from the dedicated gather-only connection
    // (`probe` above) — NOT from the main connection, whose STUN gathering gets
    // curtailed once its host-host pair connects.
    const bindingByServer = new Map();
    probe.srflx.forEach((c) => {
      if (!bindingByServer.has(c.url)) bindingByServer.set(c.url, { address: c.address, port: c.port });
    });
    const errorsByUrl = new Map();
    probe.errors.forEach((e) => {
      if (!errorsByUrl.has(e.url)) errorsByUrl.set(e.url, []);
      errorsByUrl.get(e.url).push(e.errorCode);
    });

    // One row per configured STUN server so the UI shows exactly what each one
    // did — a binding, a timeout/failure, or "no srflx (possibly deduped)".
    const stunResults = probe.stunUrls.map((url) => {
      const b = bindingByServer.get(url);
      if (b) return { server: url, ok: true, address: b.address, port: b.port, status: 'OK' };
      const codes = errorsByUrl.get(url) || [];
      const timedOut = codes.length > 0 && codes.every((c) => c >= STUN_NO_RESPONSE_CODE);
      const status = codes.length
        ? `Failed (errorCode ${[...new Set(codes)].join('/')})`
        : 'No srflx (possibly deduped against another server, or no response)';
      return { server: url, ok: false, address: null, port: null, timedOut, status };
    });

    const natType = classifyNatType(probe.hostAddresses, stunResults);

    ctx.diagSetResult({ natType, stunResults, localCandidates, remoteCandidates, pairs });
    ctx.diagSetStatus('done');
  } catch (e) {
    ctx.diagSetError(e.message);
    ctx.diagSetStatus('error');
  }
}
