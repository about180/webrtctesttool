'use strict';

// ICE servers offered to both the werift peer and (via GET /config) the
// browser. Defaults to a public STUN server; add a TURN server with the
// TURN_URL / TURN_USERNAME / TURN_CREDENTIAL env vars for clients behind
// symmetric NAT.
function buildIceServers() {
  // Air-gapped / same-LAN deployments need no STUN or TURN at all: both peers
  // reach each other directly via host candidates. LAN_ONLY=1 returns an empty
  // list so nothing on the internet is ever contacted.
  if (/^(1|true|yes)$/i.test(process.env.LAN_ONLY || '')) return [];

  const servers = [{ urls: process.env.STUN_URL || 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URL) {
    servers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || '',
    });
  }
  return servers;
}

// Optional fixed UDP port range for ICE (so a firewall can open just these
// ports). Set ICE_PORT_MIN and ICE_PORT_MAX together, e.g. 40000 / 40100.
function buildIcePortRange() {
  const min = Number(process.env.ICE_PORT_MIN);
  const max = Number(process.env.ICE_PORT_MAX);
  return min && max ? [min, max] : undefined;
}

// Shared tuning constants for the throughput tests.
module.exports = {
  PORT: process.env.PORT ? Number(process.env.PORT) : 3000,

  // WebRTC / deployment configuration (env-driven).
  ICE_SERVERS: buildIceServers(),
  ICE_PORT_RANGE: buildIcePortRange(),
  // Public IP to advertise as an extra host candidate when the server sits
  // behind 1:1 NAT (typical for cloud VMs). Set PUBLIC_IP to the reachable IP.
  PUBLIC_IP: process.env.PUBLIC_IP || undefined,

  // Payload chunk size pushed onto a DataChannel per send() call (bytes).
  CHUNK_SIZE: 16 * 1024,

  // Flow-control watermarks (bytes). The sender keeps the channel's
  // bufferedAmount between LOW and HIGH so it saturates the link without
  // growing the send buffer unboundedly.
  HIGH_WATER: 1 * 1024 * 1024,
  LOW_WATER: 256 * 1024,

  // Header layout for the "udp" (unreliable) channel: seq(uint32) + sendTs(float64).
  UDP_HEADER_SIZE: 12,

  // Channel labels agreed between browser and server.
  CH_CTRL: 'ctrl',
  CH_DATA: 'data',
  CH_UDP: 'udp',
};
