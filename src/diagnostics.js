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

// Approximate NAT-type classification. This is NOT the full RFC 3489
// Full/Restricted/Port-Restricted Cone vs Symmetric taxonomy — that requires
// a STUN server supporting CHANGE-REQUEST (RFC 5780), which public STUN
// servers no longer offer, and a browser can't send raw STUN packets to a
// self-hosted one anyway. Instead this compares the externally-mapped port
// seen across >=2 distinct STUN servers.
//
// Important subtlety: when two STUN servers report the *same* mapping (the
// hallmark of a real Cone NAT), ICE candidate deduplication (RFC 8445 §5.1.3)
// legitimately collapses them into a single surviving candidate before
// getStats() ever sees them — so "only 1 srflx candidate" is ambiguous
// between "servers agreed" (Cone) and "a server never answered" (can't tell).
// `icecandidateerror` is the only reliable per-server success/failure signal,
// independent of candidate deduplication, so it's used here to count how many
// *configured* STUN servers actually responded — not how many surviving
// candidates ended up in the (already deduped) list.
function classifyNatType(hostAddresses, stunBindings, stunConfiguredUrls, erroredStunUrls) {
  if (stunConfiguredUrls.length === 0) {
    return { kind: 'na', label: 'N/A（LAN_ONLY，未設定 STUN）' };
  }

  const respondedCount = stunConfiguredUrls.filter((u) => !erroredStunUrls.has(u)).length;

  if (stunBindings.length === 0) {
    return { kind: 'unknown', label: '無法判斷（STUN 逾時或 UDP 被封鎖）' };
  }

  if (stunBindings.some((b) => hostAddresses.has(b.address))) {
    return { kind: 'open', label: '公網 IP / 無 NAT' };
  }

  if (respondedCount < 2) {
    return {
      kind: 'insufficient',
      label: `樣本不足（僅 ${respondedCount} 個 STUN 伺服器回應，需 ≥2 個才能比對）`,
    };
  }

  const distinctPorts = new Set(stunBindings.map((b) => b.port));
  return distinctPorts.size === 1
    ? { kind: 'cone', label: 'Cone-type NAT（可預測位址轉換）' }
    : { kind: 'symmetric', label: 'Symmetric NAT（位址相依轉換）' };
}

export async function runDiagnostics(ctx) {
  ctx.diagSetStatus('running');
  ctx.diagSetError(null);
  try {
    if (!ctx.ctrl || ctx.ctrl.readyState !== 'open') {
      await connect(ctx);
    }
    await waitIceGatheringComplete(ctx.pc, 5000);
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

    const stunBindings = localCandidates
      .filter((c) => c.type === 'srflx')
      .map((c) => ({ server: c.url || '(unknown)', address: c.address, port: c.port }));

    const hostAddresses = new Set(localCandidates.filter((c) => c.type === 'host').map((c) => c.address));
    const stunConfiguredUrls = (ctx.iceServers || [])
      .map((s) => s.urls)
      .filter((u) => String(u).startsWith('stun:'));
    const erroredStunUrls = new Set((ctx.iceCandidateErrors || []).map((e) => e.url));
    const natType = classifyNatType(hostAddresses, stunBindings, stunConfiguredUrls, erroredStunUrls);

    ctx.diagSetResult({ natType, stunBindings, localCandidates, remoteCandidates, pairs });
    ctx.diagSetStatus('done');
  } catch (e) {
    ctx.diagSetError(e.message);
    ctx.diagSetStatus('error');
  }
}
