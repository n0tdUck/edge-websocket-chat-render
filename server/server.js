// WebSocket chat server.
//
// Protocol (JSON text frames):
//   client -> server  { type: "join", name, room, token? }
//                     { type: "message", text }
//                     { type: "typing" }
//                     { type: "ping" }      (keepalive; no reply)
//   server -> client  { type: "welcome", you, users, history }
//                     { type: "message", id, from, text, ts }
//                     { type: "system", text, ts }
//                     { type: "users", users }
//                     { type: "typing", from }
//                     { type: "error", message }
//
// Close codes 4000-4099 mean "don't reconnect automatically" (bad key, join timeout).

import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || undefined; // default: all interfaces, IPv4 + IPv6
const TOKEN = process.env.CHAT_TOKEN || ''; // optional shared access key

const HISTORY_SIZE = 50;
const MAX_TEXT = 2000;
const MAX_NAME = 32;
const MAX_ROOM = 32;
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_MESSAGES = 10;
const HEARTBEAT_MS = 30_000;
const JOIN_TIMEOUT_MS = 10_000;

// room name -> { clients: Set<WebSocket>, history: ChatMessage[] }
const rooms = new Map();

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(426, { 'content-type': 'text/plain' });
  res.end('This is a WebSocket chat server. Connect with ws:// or wss://.\n');
});

const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  ws.isAlive = true;
  ws.user = null;
  ws.sent = [];
  ws.lastTyping = 0;

  ws.on('pong', () => { ws.isAlive = true; });

  const joinTimer = setTimeout(() => {
    if (!ws.user) ws.close(4000, 'Join timeout');
  }, JOIN_TIMEOUT_MS);

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return sendError(ws, 'Invalid JSON');
    }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'join': return handleJoin(ws, msg, ip);
      case 'message': return handleMessage(ws, msg);
      case 'typing': return handleTyping(ws);
      // App-level keepalive: free hosts like Render count inbound messages, not ping/pong frames, as activity.
      case 'ping': return;
      default: return sendError(ws, `Unknown message type: ${msg.type}`);
    }
  });

  ws.on('close', () => {
    clearTimeout(joinTimer);
    leave(ws);
  });

  ws.on('error', (err) => log(`socket error (${ip}): ${err.message}`));
});

function handleJoin(ws, msg, ip) {
  if (ws.user) return sendError(ws, 'Already joined');

  if (TOKEN && !safeEqual(String(msg.token ?? ''), TOKEN)) {
    send(ws, { type: 'error', message: 'Invalid access key' });
    ws.close(4001, 'Invalid access key');
    return;
  }

  const name = cleanLine(msg.name, MAX_NAME);
  const roomName = cleanLine(msg.room, MAX_ROOM).toLowerCase() || 'lobby';
  if (!name) return sendError(ws, 'Nickname is required');

  let room = rooms.get(roomName);
  if (!room) {
    room = { clients: new Set(), history: [] };
    rooms.set(roomName, room);
  }

  ws.user = { id: crypto.randomUUID(), name: uniqueName(room, name), room: roomName };
  room.clients.add(ws);

  send(ws, { type: 'welcome', you: ws.user, users: userList(room), history: room.history });
  broadcast(room, { type: 'system', text: `${ws.user.name} joined`, ts: Date.now() }, ws);
  broadcast(room, { type: 'users', users: userList(room) });
  log(`${ws.user.name} joined #${roomName} from ${ip} (${room.clients.size} online)`);
}

function handleMessage(ws, msg) {
  if (!ws.user) return sendError(ws, 'Join a room first');

  const text = cleanText(msg.text);
  if (!text) return;
  if (text.length > MAX_TEXT) return sendError(ws, `Message too long (max ${MAX_TEXT} characters)`);
  if (isRateLimited(ws)) return sendError(ws, 'You are sending messages too fast');

  const room = rooms.get(ws.user.room);
  const chat = {
    type: 'message',
    id: crypto.randomUUID(),
    from: { id: ws.user.id, name: ws.user.name },
    text,
    ts: Date.now(),
  };
  room.history.push(chat);
  if (room.history.length > HISTORY_SIZE) room.history.shift();
  broadcast(room, chat);
}

function handleTyping(ws) {
  if (!ws.user) return;
  const now = Date.now();
  if (now - ws.lastTyping < 1000) return;
  ws.lastTyping = now;
  const room = rooms.get(ws.user.room);
  broadcast(room, { type: 'typing', from: { id: ws.user.id, name: ws.user.name } }, ws);
}

function leave(ws) {
  if (!ws.user) return;
  const { name, room: roomName } = ws.user;
  const room = rooms.get(roomName);
  if (!room) return;

  room.clients.delete(ws);
  if (room.clients.size === 0) {
    // History lives only as long as someone is in the room.
    rooms.delete(roomName);
  } else {
    broadcast(room, { type: 'system', text: `${name} left`, ts: Date.now() });
    broadcast(room, { type: 'users', users: userList(room) });
  }
  log(`${name} left #${roomName} (${room.clients.size} online)`);
}

// --- helpers -----------------------------------------------------------------

function send(ws, data) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
}

function sendError(ws, message) {
  send(ws, { type: 'error', message });
}

function broadcast(room, data, except) {
  const payload = JSON.stringify(data);
  for (const client of room.clients) {
    if (client !== except && client.readyState === client.OPEN) client.send(payload);
  }
}

function userList(room) {
  return [...room.clients].map((c) => ({ id: c.user.id, name: c.user.name }));
}

function uniqueName(room, name) {
  const taken = new Set([...room.clients].map((c) => c.user.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) {
    const candidate = `${name} (${i})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

// Single-line input (names, rooms): strip all control characters.
function cleanLine(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

// Message text: keep newlines and tabs, strip other control characters.
function cleanText(value) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
}

function isRateLimited(ws) {
  const now = Date.now();
  ws.sent = ws.sent.filter((t) => now - t < RATE_WINDOW_MS);
  if (ws.sent.length >= RATE_MAX_MESSAGES) return true;
  ws.sent.push(now);
  return false;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function log(line) {
  console.log(`[${new Date().toISOString()}] ${line}`);
}

// Drop connections that stopped answering pings (closed laptop, dead Wi-Fi).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);

function shutdown() {
  log('Shutting down...');
  clearInterval(heartbeat);
  for (const ws of wss.clients) ws.close(1001, 'Server shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
  log(`Chat server listening on ws://${HOST || 'localhost'}:${PORT}${TOKEN ? ' (access key required)' : ''}`);
});
