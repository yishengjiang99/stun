import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const publicDir = path.join(__dirname, 'public');

const server = http.createServer((req, res) => {
  const urlPath = req.url === '/' ? '/index.html' : req.url;
  const filePath = path.join(publicDir, urlPath);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath);
    const contentType = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css'
    }[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Map());
  }
  return rooms.get(roomId);
}

function broadcastToRoom(roomId, payload, exceptId = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const [peerId, ws] of room.entries()) {
    if (peerId === exceptId) continue;
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }
}

wss.on('connection', (ws) => {
  let roomId = null;
  let peerId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'join') {
      roomId = msg.roomId;
      peerId = msg.peerId;
      const room = getRoom(roomId);
      room.set(peerId, ws);

      const peers = Array.from(room.keys()).filter((id) => id !== peerId);
      ws.send(JSON.stringify({ type: 'peers', peers }));
      broadcastToRoom(roomId, { type: 'peer-joined', peerId }, peerId);
      return;
    }

    if (!roomId || !peerId) return;

    if (msg.type === 'signal') {
      const room = rooms.get(roomId);
      if (!room) return;
      const target = room.get(msg.to);
      if (target && target.readyState === target.OPEN) {
        target.send(JSON.stringify({
          type: 'signal',
          from: peerId,
          data: msg.data
        }));
      }
    }
  });

  ws.on('close', () => {
    if (!roomId || !peerId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    room.delete(peerId);
    broadcastToRoom(roomId, { type: 'peer-left', peerId }, peerId);
    if (room.size === 0) {
      rooms.delete(roomId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Signaling server running on http://localhost:${PORT}`);
});
