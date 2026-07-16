'use strict';

// Shared tuning constants for the throughput tests.
module.exports = {
  PORT: process.env.PORT ? Number(process.env.PORT) : 3000,

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
