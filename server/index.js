'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const { PORT, ICE_SERVERS } = require('./config');
const { handleConnection } = require('./signaling');

const app = express();

// The browser fetches its ICE servers here so TURN config lives only on the
// server. (These credentials are meant to be used by the client, so it's fine
// to hand them over — use short-lived TURN credentials in production.)
app.get('/config', (req, res) => res.json({ iceServers: ICE_SERVERS }));

// Serve the Vite build output. Run `npm run build` first (or copy a prebuilt
// dist/ over, e.g. for an offline Node 16 device — see README).
const DIST = path.join(__dirname, '..', 'dist');
if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.warn(
    '[warn] dist/ not found — run `npm run build` first ' +
      '(or copy a prebuilt dist/ here). The API/WebSocket endpoints still work.'
  );
}
app.use(express.static(DIST));

const server = http.createServer(app);

// Signaling endpoint. Every browser session opens one WebSocket here.
const wss = new WebSocketServer({ server, path: '/ws' });
let nextId = 1;
wss.on('connection', (ws) => handleConnection(ws, nextId++));

server.listen(PORT, () => {
  console.log(`webrtctesttool listening on http://localhost:${PORT}`);
});
