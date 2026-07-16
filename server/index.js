'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const { PORT } = require('./config');
const { handleConnection } = require('./signaling');

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);

// Signaling endpoint. Every browser session opens one WebSocket here.
const wss = new WebSocketServer({ server, path: '/ws' });
let nextId = 1;
wss.on('connection', (ws) => handleConnection(ws, nextId++));

server.listen(PORT, () => {
  console.log(`webrtctesttool listening on http://localhost:${PORT}`);
});
