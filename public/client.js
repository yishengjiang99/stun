const joinBtn = document.getElementById('joinBtn');
const leaveBtn = document.getElementById('leaveBtn');
const roomInput = document.getElementById('roomInput');
const localVideo = document.getElementById('localVideo');
const localCanvas = document.getElementById('localCanvas');
const localStatus = document.getElementById('localStatus');
const remoteGrid = document.getElementById('remoteGrid');
const remoteStatus = document.getElementById('remoteStatus');

const peerId = crypto.randomUUID();
let socket = null;
let roomId = null;
let localStream = null;
let peers = new Map();
let faceDetector = null;

// Metered Open Relay TURN (free tier) requires credentials from their dashboard.
// Fill these in with the values you receive from Metered.
const TURN_CONFIG = {
  urls: [
    'turn:openrelay.metered.ca:80',
    'turn:openrelay.metered.ca:443',
    'turn:openrelay.metered.ca:443?transport=tcp'
  ],
  username: 'YOUR_TURN_USERNAME',
  credential: 'YOUR_TURN_CREDENTIAL'
};

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    TURN_CONFIG
  ]
};

function logStatus(target, text) {
  target.textContent = text;
}

async function initLocalMedia() {
  localStream = await navigator.mediaDevices.getUserMedia({
    video: true,
    audio: true
  });
  localVideo.srcObject = localStream;

  const videoTrack = localStream.getVideoTracks()[0];
  if (videoTrack) {
    videoTrack.addEventListener('unmute', () => {
      startFaceLoop(localVideo, localCanvas);
    }, { once: true });
  }
}

function setupFaceDetector() {
  if ('FaceDetector' in window) {
    faceDetector = new FaceDetector({ fastMode: true, maxDetectedFaces: 6 });
  }
}

function ensureCanvasSize(video, canvas) {
  const { videoWidth, videoHeight } = video;
  if (!videoWidth || !videoHeight) return;
  if (canvas.width !== videoWidth || canvas.height !== videoHeight) {
    canvas.width = videoWidth;
    canvas.height = videoHeight;
  }
}

function drawBoxes(canvas, faces) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#2fd6b5';
  for (const face of faces) {
    const { x, y, width, height } = face.boundingBox;
    ctx.strokeRect(x, y, width, height);
  }
}

function startFaceLoop(video, canvas) {
  if (!faceDetector) {
    logStatus(localStatus, 'FaceDetector not supported in this browser');
    return;
  }

  const loop = async () => {
    if (video.readyState < 2) {
      scheduleNext();
      return;
    }

    ensureCanvasSize(video, canvas);

    try {
      const faces = await faceDetector.detect(video);
      drawBoxes(canvas, faces);
    } catch (err) {
      // ignore detection errors on some frames
    }

    scheduleNext();
  };

  const scheduleNext = () => {
    if (typeof video.requestVideoFrameCallback === 'function') {
      video.requestVideoFrameCallback(loop);
    } else {
      setTimeout(loop, 120);
    }
  };

  scheduleNext();
}

function createPeerConnection(remoteId) {
  const pc = new RTCPeerConnection(rtcConfig);

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.send(JSON.stringify({
        type: 'signal',
        to: remoteId,
        data: { candidate: event.candidate }
      }));
    }
  };

  pc.ontrack = (event) => {
    const [stream] = event.streams;
    if (!stream) return;

    let entry = peers.get(remoteId);
    if (entry && entry.stream === stream) return;

    if (!entry) {
      entry = createRemoteTile(remoteId);
      peers.set(remoteId, { ...entry, pc, stream });
    }

    entry.video.srcObject = stream;

    const track = stream.getVideoTracks()[0];
    if (track) {
      track.addEventListener('unmute', () => {
        startFaceLoop(entry.video, entry.canvas);
      }, { once: true });
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      removePeer(remoteId);
    }
  };

  return pc;
}

function createRemoteTile(remoteId) {
  const wrap = document.createElement('div');
  wrap.className = 'video-wrap';

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;

  const canvas = document.createElement('canvas');

  wrap.appendChild(video);
  wrap.appendChild(canvas);
  wrap.dataset.peerId = remoteId;

  remoteGrid.appendChild(wrap);
  updateRemoteStatus();

  return { wrap, video, canvas };
}

function updateRemoteStatus() {
  if (remoteGrid.children.length === 0) {
    remoteStatus.textContent = 'No peers';
  } else {
    remoteStatus.textContent = `${remoteGrid.children.length} peer(s) connected`;
  }
}

function removePeer(remoteId) {
  const entry = peers.get(remoteId);
  if (!entry) return;
  if (entry.pc) entry.pc.close();
  if (entry.wrap) entry.wrap.remove();
  peers.delete(remoteId);
  updateRemoteStatus();
}

async function handleSignal(from, data) {
  let entry = peers.get(from);
  if (!entry) {
    const pc = createPeerConnection(from);
    entry = { pc };
    peers.set(from, entry);
  }

  const pc = entry.pc;

  if (data.sdp) {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    if (data.sdp.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.send(JSON.stringify({
        type: 'signal',
        to: from,
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

async function createOffer(remoteId) {
  const entry = peers.get(remoteId) || { pc: createPeerConnection(remoteId) };
  peers.set(remoteId, entry);
  const offer = await entry.pc.createOffer();
  await entry.pc.setLocalDescription(offer);
  socket.send(JSON.stringify({
    type: 'signal',
    to: remoteId,
    data: { sdp: entry.pc.localDescription }
  }));
}

function connectSocket() {
  socket = new WebSocket(`ws://${location.host}`);

  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'join', roomId, peerId }));
  });

  socket.addEventListener('message', async (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === 'peers') {
      for (const id of msg.peers) {
        await createOffer(id);
      }
      return;
    }

    if (msg.type === 'peer-joined') {
      await createOffer(msg.peerId);
      return;
    }

    if (msg.type === 'peer-left') {
      removePeer(msg.peerId);
      return;
    }

    if (msg.type === 'signal') {
      await handleSignal(msg.from, msg.data);
    }
  });

  socket.addEventListener('close', () => {
    logStatus(localStatus, 'Disconnected');
  });
}

function cleanup() {
  for (const id of peers.keys()) {
    removePeer(id);
  }
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
  }
  localStream = null;
  if (socket) {
    socket.close();
  }
  socket = null;
}

joinBtn.addEventListener('click', async () => {
  joinBtn.disabled = true;
  roomId = roomInput.value.trim() || 'demo-room';
  setupFaceDetector();
  await initLocalMedia();
  connectSocket();
  logStatus(localStatus, `Joined ${roomId}`);
  leaveBtn.disabled = false;
});

leaveBtn.addEventListener('click', () => {
  cleanup();
  leaveBtn.disabled = true;
  joinBtn.disabled = false;
  logStatus(localStatus, 'Not connected');
  updateRemoteStatus();
});

window.addEventListener('beforeunload', () => {
  cleanup();
});
