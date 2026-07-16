'use strict';

const { RTCPeerConnection } = require('werift');
const { Session } = require('./peer');
const { ICE_SERVERS, ICE_PORT_RANGE, PUBLIC_IP } = require('./config');

function buildPeerConfig() {
  const cfg = { iceServers: ICE_SERVERS };
  if (ICE_PORT_RANGE) cfg.icePortRange = ICE_PORT_RANGE;
  if (PUBLIC_IP) cfg.iceAdditionalHostAddresses = [PUBLIC_IP];
  return cfg;
}

/**
 * Handle one signaling WebSocket connection.
 *
 * The browser is the WebRTC initiator: it sends an SDP offer and ICE
 * candidates over this socket; we answer with a werift RTCPeerConnection and
 * relay our own candidates back. Once the browser-created DataChannels arrive
 * we hand them to a Session which implements the test protocol.
 */
function handleConnection(ws, id) {
  const log = (...a) => console.log(`[session ${id}]`, ...a);
  log('connected');

  const pc = new RTCPeerConnection(buildPeerConfig());
  const session = new Session(log);

  const wsSend = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };

  // Trickle our ICE candidates to the browser.
  pc.onIceCandidate.subscribe((candidate) => {
    if (candidate) wsSend({ type: 'candidate', candidate });
  });

  pc.connectionStateChange.subscribe((state) => {
    log('connection state:', state);
    if (state === 'failed' || state === 'closed') cleanup();
  });

  // Browser-created DataChannels surface here.
  pc.onDataChannel.subscribe((channel) => {
    log('datachannel:', channel.label);
    session.attachChannel(channel);
  });

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }

    try {
      if (msg.type === 'offer') {
        await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        wsSend({ type: 'answer', sdp: pc.localDescription.sdp });
      } else if (msg.type === 'candidate' && msg.candidate) {
        await pc.addIceCandidate(msg.candidate);
      }
    } catch (e) {
      log('signaling error:', e.message);
    }
  });

  function cleanup() {
    try {
      pc.close();
    } catch (e) {
      /* ignore */
    }
    if (ws.readyState === ws.OPEN) ws.close();
  }

  ws.on('close', () => {
    log('disconnected');
    cleanup();
  });
  ws.on('error', () => cleanup());
}

module.exports = { handleConnection };
