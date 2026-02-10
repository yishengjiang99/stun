import { WebSocket } from 'ws';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import wrtc from 'wrtc';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStaticPath from 'ffmpeg-static';

const {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  nonstandard: { RTCVideoSource }
} = wrtc;

const ROOM_ID = process.env.DEMO_ROOM_ID || 'demo-room';
const PEER_ID = process.env.DEMO_PEER_ID || 'server-bot';
const SIGNALING_URL = process.env.SIGNALING_URL || 'ws://127.0.0.1:3000';
const DEMO_VIDEO_PATH = process.env.DEMO_VIDEO_PATH || path.join(process.cwd(), 'assets', 'demo.mp4');

const WIDTH = Number(process.env.DEMO_VIDEO_WIDTH || 1280);
const HEIGHT = Number(process.env.DEMO_VIDEO_HEIGHT || 720);
const FPS = Number(process.env.DEMO_VIDEO_FPS || 30);

const resolvedFfmpegPath = process.env.FFMPEG_PATH || ffmpegStaticPath || null;
if (resolvedFfmpegPath) {
  ffmpeg.setFfmpegPath(resolvedFfmpegPath);
  console.log('[server-peer] ffmpeg path', resolvedFfmpegPath);
} else {
  console.warn('[server-peer] ffmpeg path not set; ensure ffmpeg is installed and set FFMPEG_PATH');
}

function isPolitePeer(remoteId) {
  return PEER_ID < remoteId;
}

const videoSources = new Set();

function createVideoTrack() {
  const source = new RTCVideoSource();
  videoSources.add(source);
  const track = source.createTrack();
  return { source, track };
}

async function startVideoSource() {
  const demoPath = DEMO_VIDEO_PATH;
  try {
    await fs.access(demoPath);
  } catch {
    console.error('[server-peer] demo video not found', demoPath);
    throw new Error(`Demo video not found: ${demoPath}`);
  }
  console.log('[server-peer] start video source', {
    width: WIDTH,
    height: HEIGHT,
    fps: FPS,
    demoPath
  });
  let frameWidth = WIDTH;
  let frameHeight = HEIGHT;
  let expectedFrameSize = Math.floor(frameWidth * frameHeight * 1.5);
  let buffer = Buffer.alloc(0);
  let frames = 0;
  let headerParsed = false;

  const command = ffmpeg();
  command.input(demoPath).inputOptions(['-stream_loop', '-1']);

  command
    .outputOptions([
      '-an',
      '-c:v', 'rawvideo',
      '-pix_fmt', 'yuv420p',
      '-vf', `scale=${WIDTH}:${HEIGHT}`,
      '-r', String(FPS)
    ])
    .format('yuv4mpegpipe')
    .on('start', (cmd) => {
      console.log('[server-peer] ffmpeg start', cmd);
    })
    .on('stderr', (line) => {
      console.log('[server-peer] ffmpeg', line);
    })
    .on('error', (err) => {
      console.error('[server-peer] ffmpeg error', err);
    });

  const stream = command.pipe();
  stream.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      if (!headerParsed) {
        const headerEnd = buffer.indexOf('\n');
        if (headerEnd === -1) return;
        const header = buffer.subarray(0, headerEnd).toString();
        buffer = buffer.subarray(headerEnd + 1);
        const wMatch = header.match(/W(\\d+)/);
        const hMatch = header.match(/H(\\d+)/);
        if (wMatch && hMatch) {
          frameWidth = Number(wMatch[1]);
          frameHeight = Number(hMatch[1]);
          expectedFrameSize = Math.floor(frameWidth * frameHeight * 1.5);
          console.log('[server-peer] y4m header', header, 'frameSize', expectedFrameSize);
        }
        headerParsed = true;
        continue;
      }

      const markerEnd = buffer.indexOf('\n');
      if (markerEnd === -1) return;
      const marker = buffer.subarray(0, markerEnd).toString();
      if (!marker.startsWith('FRAME')) {
        buffer = buffer.subarray(markerEnd + 1);
        continue;
      }
      buffer = buffer.subarray(markerEnd + 1);

      if (buffer.length < expectedFrameSize) return;
      const frame = buffer.subarray(0, expectedFrameSize);
      buffer = buffer.subarray(expectedFrameSize);

      frames += 1;
      if (frames % 60 === 0) {
        console.log('[server-peer] frames pushed', frames);
      }
      try {
        const data = new Uint8ClampedArray(expectedFrameSize);
        data.set(frame);
        for (const source of videoSources) {
          source.onFrame({
            width: frameWidth,
            height: frameHeight,
            data
          });
        }
      } catch (err) {
        console.error('[server-peer] onFrame error', err);
      }
    }
  });
  stream.on('error', (err) => {
    console.error('[server-peer] stream error', err);
  });

  return () => {
    stream.destroy();
    command.kill('SIGKILL');
  };
}

function createPeerConnection(socket, remoteId) {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });

  const { source, track } = createVideoTrack();
  pc.addTrack(track);

  let makingOffer = false;
  let ignoreOffer = false;

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.send(JSON.stringify({
        type: 'signal',
        to: remoteId,
        data: { candidate: event.candidate }
      }));
    }
  };

  pc.onnegotiationneeded = async () => {
    try {
      makingOffer = true;
      const offer = await pc.createOffer();
      if (pc.signalingState !== 'stable') return;
      await pc.setLocalDescription(offer);
      socket.send(JSON.stringify({
        type: 'signal',
        to: remoteId,
        data: { sdp: pc.localDescription }
      }));
    } catch (err) {
      console.error('[server-peer] negotiation error', err);
    } finally {
      makingOffer = false;
    }
  };

  pc.onconnectionstatechange = () => {
    console.log('[server-peer] connectionState', remoteId, pc.connectionState);
  };

  pc.oniceconnectionstatechange = () => {
    console.log('[server-peer] iceConnectionState', remoteId, pc.iceConnectionState);
  };

  return {
    pc,
    source,
    makingOfferRef: () => makingOffer,
    getIgnoreOffer: () => ignoreOffer,
    setIgnoreOffer: (v) => { ignoreOffer = v; }
  };
}

function createSignalingClient() {
  const peers = new Map();
  let stopMedia = null;
  let stopMediaPromise = null;

  const socket = new WebSocket(SIGNALING_URL);

  socket.on('open', () => {
    console.log('[server-peer] ws open', SIGNALING_URL);
    socket.send(JSON.stringify({ type: 'join', roomId: ROOM_ID, peerId: PEER_ID }));
    if (!stopMediaPromise) {
      stopMediaPromise = startVideoSource().then((stop) => { stopMedia = stop; }).catch((err) => {
        console.error('[server-peer] startMedia failed', err);
      });
    }
  });

  socket.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'peers') {
      for (const id of msg.peers) {
        if (!peers.has(id)) {
          const peerState = createPeerConnection(socket, id);
          peers.set(id, peerState);
        }
      }
      return;
    }

    if (msg.type === 'peer-joined') {
      if (!peers.has(msg.peerId)) {
        const peerState = createPeerConnection(socket, msg.peerId);
        peers.set(msg.peerId, peerState);
      }
      return;
    }

    if (msg.type === 'peer-left') {
      const peerState = peers.get(msg.peerId);
      if (peerState) {
        peerState.pc.close();
        peers.delete(msg.peerId);
      }
      return;
    }

    if (msg.type === 'signal') {
      const peerState = peers.get(msg.from) || createPeerConnection(socket, msg.from);
      if (!peers.has(msg.from)) {
        peers.set(msg.from, peerState);
      }

      const pc = peerState.pc;
      const data = msg.data;

      if (data.sdp) {
        const offerCollision = data.sdp.type === 'offer' &&
          (peerState.getIgnoreOffer() || peerState.makingOfferRef() || pc.signalingState !== 'stable');
        const polite = isPolitePeer(msg.from);
        if (offerCollision) {
          peerState.setIgnoreOffer(!polite);
          if (!polite) {
            console.warn('[server-peer] ignoring offer due to collision', msg.from);
            return;
          }
        }

        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        if (data.sdp.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.send(JSON.stringify({
            type: 'signal',
            to: msg.from,
            data: { sdp: pc.localDescription }
          }));
        }
      }

      if (data.candidate) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch {
          // ignore
        }
      }
    }
  });

  socket.on('close', () => {
    console.warn('[server-peer] ws closed');
  });

  socket.on('error', (err) => {
    console.error('[server-peer] ws error', err);
  });
}

createSignalingClient();
