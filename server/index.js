'use strict';

const path = require('path');
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

app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);

// Signaling endpoint. Every browser session opens one WebSocket here.
const wss = new WebSocketServer({ server, path: '/ws' });
let nextId = 1;
wss.on('connection', (ws) => handleConnection(ws, nextId++));

server.listen(PORT, () => {
  console.log(`webrtctesttool listening on http://localhost:${PORT}`);
});
