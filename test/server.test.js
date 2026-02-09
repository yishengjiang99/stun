import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createServer } from '../server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');

async function startServer() {
  const { server, rooms, close } = createServer({ publicDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    server,
    rooms,
    close,
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`
  };
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => resolve({ res, data }));
    });
    req.on('error', reject);
  });
}

function waitForMessage(ws, predicate) {
  return new Promise((resolve, reject) => {
    const onMessage = (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (predicate(msg)) {
        ws.off('message', onMessage);
        ws.off('error', onError);
        resolve(msg);
      }
    };
    const onError = (err) => {
      ws.off('message', onMessage);
      ws.off('error', onError);
      reject(err);
    };
    ws.on('message', onMessage);
    ws.on('error', onError);
  });
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

async function closeWs(ws) {
  if (ws.readyState === ws.CLOSED) return;
  await new Promise((resolve) => {
    ws.once('close', resolve);
    ws.close();
  });
}

test('serves index.html and sets content type', async () => {
  const { url, close } = await startServer();
  const { res, data } = await httpGet(`${url}/`);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(data, /<html/i);
  await close();
});

test('returns 404 for missing files', async () => {
  const { url, close } = await startServer();
  const { res } = await httpGet(`${url}/missing.txt`);
  assert.equal(res.statusCode, 404);
  await close();
});

test('blocks path traversal attempts', async () => {
  const { url, close } = await startServer();
  const { res } = await httpGet(`${url}/../package.json`);
  assert.equal(res.statusCode, 403);
  await close();
});

test('handles join, peers, signal, and peer-left', async () => {
  const { wsUrl, close, rooms } = await startServer();
  const wsA = await openWs(wsUrl);
  const wsB = await openWs(wsUrl);

  wsA.send(JSON.stringify({ type: 'join', roomId: 'room1', peerId: 'peerA' }));
  const peersA = await waitForMessage(wsA, (msg) => msg.type === 'peers');
  assert.deepEqual(peersA.peers, []);

  wsB.send(JSON.stringify({ type: 'join', roomId: 'room1', peerId: 'peerB' }));
  const peersB = await waitForMessage(wsB, (msg) => msg.type === 'peers');
  assert.deepEqual(peersB.peers, ['peerA']);
  const joined = await waitForMessage(wsA, (msg) => msg.type === 'peer-joined');
  assert.equal(joined.peerId, 'peerB');

  wsB.send(JSON.stringify({
    type: 'signal',
    to: 'peerA',
    data: { sdp: 'offer' }
  }));
  const signal = await waitForMessage(wsA, (msg) => msg.type === 'signal');
  assert.equal(signal.from, 'peerB');
  assert.deepEqual(signal.data, { sdp: 'offer' });

  await closeWs(wsB);
  const left = await waitForMessage(wsA, (msg) => msg.type === 'peer-left');
  assert.equal(left.peerId, 'peerB');

  await closeWs(wsA);
  await close();

  assert.equal(rooms.size, 0);
});
