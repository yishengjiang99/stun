import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultPublicDir = path.join(__dirname, 'public');

export function createServer({ publicDir = defaultPublicDir } = {}) {
  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://localhost');
    const urlPath = requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;

    if (requestUrl.pathname === '/rooms') {
      const list = Array.from(rooms.entries()).map(([id, room]) => ({
        roomId: id,
        participants: room.size
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ rooms: list }));
      return;
    }

    const filePath = path.join(publicDir, decodeURIComponent(urlPath));

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
    console.log('[ws] connection opened');

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        console.warn('[ws] invalid json');
        return;
      }

      if (msg.type === 'join') {
        roomId = msg.roomId;
        peerId = msg.peerId;
        console.log(`[ws] join room=${roomId} peer=${peerId}`);
        const room = getRoom(roomId);
        const existing = room.get(peerId);
        if (existing && existing !== ws) {
          if (existing.readyState === existing.OPEN) {
            existing.close(1000, 'duplicate peerId');
          }
        }
        room.set(peerId, ws);

        const peers = Array.from(room.keys()).filter((id) => id !== peerId);
        ws.send(JSON.stringify({ type: 'peers', peers }));
        console.log(`[ws] peers to=${peerId} room=${roomId} list=${peers.join(',')}`);
        broadcastToRoom(roomId, { type: 'peer-joined', peerId }, peerId);
        return;
      }

      if (!roomId || !peerId) return;

      if (msg.type === 'signal') {
        const room = rooms.get(roomId);
        if (!room) return;
        const target = room.get(msg.to);
        if (target && target.readyState === target.OPEN) {
          const signalType = msg.data?.sdp?.type || (msg.data?.candidate ? 'candidate' : 'unknown');
          console.log(`[signal] room=${roomId} from=${peerId} to=${msg.to} type=${signalType}`);
          target.send(JSON.stringify({
            type: 'signal',
            from: peerId,
            data: msg.data
          }));
        }
      }
    });

    ws.on('close', () => {
      console.log(`[ws] close room=${roomId || '-'} peer=${peerId || '-'}`);
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

  function close() {
    return new Promise((resolve) => {
      wss.close(() => {
        server.close(() => resolve());
      });
    });
  }

  return { server, wss, rooms, close };
}

const isEntry = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntry) {
  const { server } = createServer();
  const PORT = process.env.PORT || 3001;
  server.listen(PORT, () => {
    console.log(`Signaling server running on http://localhost:${PORT}`);
  });
}
