import { WebSocket } from 'ws';
import wrtc from 'wrtc';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';

const {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  nonstandard: { RTCVideoSource }
} = wrtc;

const ROOM_ID = process.env.DEMO_ROOM_ID || 'demo-room';
const PEER_ID = process.env.DEMO_PEER_ID || 'server-bot';
const SIGNALING_URL = process.env.SIGNALING_URL || 'ws://127.0.0.1:3000';
const DEMO_VIDEO_PATH = process.env.DEMO_VIDEO_PATH || '';

const WIDTH = Number(process.env.DEMO_VIDEO_WIDTH || 1280);
const HEIGHT = Number(process.env.DEMO_VIDEO_HEIGHT || 720);
const FPS = Number(process.env.DEMO_VIDEO_FPS || 30);

ffmpeg.setFfmpegPath(ffmpegPath);

function isPolitePeer(remoteId) {
  return PEER_ID < remoteId;
}

function createVideoTrack() {
  const source = new RTCVideoSource();
  const track = source.createTrack();
  return { source, track };
}

function startVideoSource(source) {
  const frameSize = Math.floor(WIDTH * HEIGHT * 1.5);
  let buffer = Buffer.alloc(0);
  let frames = 0;

  const command = ffmpeg()
    .input(DEMO_VIDEO_PATH || 'testsrc=size=1280x720:rate=30')
    .inputOptions(DEMO_VIDEO_PATH ? ['-stream_loop', '-1'] : ['-f', 'lavfi'])
    .outputOptions([
      '-an',
      '-c:v', 'rawvideo',
      '-pix_fmt', 'yuv420p',
      '-vf', `scale=${WIDTH}:${HEIGHT}`,
      '-r', String(FPS)
    ])
    .format('rawvideo')
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
    while (buffer.length >= frameSize) {
      const frame = buffer.subarray(0, frameSize);
      buffer = buffer.subarray(frameSize);
      frames += 1;
      if (frames % 60 === 0) {
        console.log('[server-peer] frames pushed', frames);
      }
      source.onFrame({
        width: WIDTH,
        height: HEIGHT,
        data: new Uint8ClampedArray(frame.buffer, frame.byteOffset, frame.byteLength)
      });
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
    startMedia: () => startVideoSource(source),
    makingOfferRef: () => makingOffer,
    getIgnoreOffer: () => ignoreOffer,
    setIgnoreOffer: (v) => { ignoreOffer = v; }
  };
}

function createSignalingClient() {
  const peers = new Map();
  let stopMedia = null;

  const socket = new WebSocket(SIGNALING_URL);

  socket.on('open', () => {
    console.log('[server-peer] ws open', SIGNALING_URL);
    socket.send(JSON.stringify({ type: 'join', roomId: ROOM_ID, peerId: PEER_ID }));
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
          if (!stopMedia) stopMedia = peerState.startMedia();
        }
      }
      return;
    }

    if (msg.type === 'peer-joined') {
      if (!peers.has(msg.peerId)) {
        const peerState = createPeerConnection(socket, msg.peerId);
        peers.set(msg.peerId, peerState);
        if (!stopMedia) stopMedia = peerState.startMedia();
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
        if (!stopMedia) stopMedia = peerState.startMedia();
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
