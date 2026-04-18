const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const STATIC_DIR = path.join(__dirname, 'dist', 'baseball-game', 'browser');

const app = express();

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

if (fs.existsSync(STATIC_DIR)) {
  app.use(express.static(STATIC_DIR, { maxAge: '1h' }));
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(STATIC_DIR, 'index.html'));
  });
} else {
  app.get('/', (_req, res) =>
    res.status(500).send(`Build output missing at ${STATIC_DIR}`),
  );
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

/** code -> { p1?: ws, p2?: ws, createdAt: number } */
const rooms = new Map();

function makeCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  for (let tries = 0; tries < 25; tries++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
    if (!rooms.has(c)) return c;
  }
  return Date.now().toString(36).toUpperCase().slice(-4);
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj) {
  send(room.p1, obj);
  send(room.p2, obj);
}

function peerOf(room, ws) {
  if (room.p1 === ws) return room.p2;
  if (room.p2 === ws) return room.p1;
  return null;
}

function roleOf(room, ws) {
  if (room.p1 === ws) return 'p1';
  if (room.p2 === ws) return 'p2';
  return null;
}

function cleanupEmpty(code) {
  const r = rooms.get(code);
  if (!r) return;
  if (!r.p1 && !r.p2) rooms.delete(code);
}

wss.on('connection', (ws) => {
  ws.roomCode = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'create') {
      if (ws.roomCode) return send(ws, { type: 'error', msg: 'already in a room' });
      const code = makeCode();
      rooms.set(code, { p1: ws, createdAt: Date.now() });
      ws.roomCode = code;
      send(ws, { type: 'created', code, role: 'p1' });
      return;
    }

    if (msg.type === 'join') {
      const code = String(msg.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(ws, { type: 'error', msg: 'Room not found' });
      if (room.p2) return send(ws, { type: 'error', msg: 'Room is full' });
      room.p2 = ws;
      ws.roomCode = code;
      send(ws, { type: 'joined', code, role: 'p2' });
      send(room.p1, { type: 'peer_joined' });
      broadcast(room, { type: 'start' });
      return;
    }

    const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
    if (!room) return;
    const role = roleOf(room, ws);
    if (!role) return;

    if (msg.type === 'pitch') {
      const t0 = Date.now();
      broadcast(room, {
        type: 'pitch',
        pitchType: msg.pitchType,
        seed: msg.seed,
        t0,
        from: role,
      });
      return;
    }

    if (msg.type === 'swing') {
      broadcast(room, {
        type: 'swing_result',
        offsetMs: msg.offsetMs,
        swingerRole: role,
        pitchType: msg.pitchType,
      });
      return;
    }

    if (msg.type === 'miss') {
      broadcast(room, {
        type: 'miss',
        swingerRole: role,
        pitchType: msg.pitchType,
      });
      return;
    }
  });

  ws.on('close', () => {
    const code = ws.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    if (room.p1 === ws) room.p1 = null;
    if (room.p2 === ws) room.p2 = null;
    const peer = peerOf(room, ws);
    if (peer) send(peer, { type: 'peer_left' });
    cleanupEmpty(code);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) {
    if (!r.p1 && !r.p2) rooms.delete(code);
    else if (now - r.createdAt > 1000 * 60 * 60 * 2) rooms.delete(code);
  }
}, 60_000);

server.listen(PORT, () => {
  console.log(`baseball-game listening on :${PORT}`);
});
