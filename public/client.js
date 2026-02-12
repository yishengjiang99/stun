const joinBtn = document.getElementById('joinBtn');
const leaveBtn = document.getElementById('leaveBtn');
const roomInput = document.getElementById('roomInput');
const localVideo = document.getElementById('localVideo');
const localCanvas = document.getElementById('localCanvas');
const localStatus = document.getElementById('localStatus');
const remoteGrid = document.getElementById('remoteGrid');
const remoteStatus = document.getElementById('remoteStatus');
const localWrap = document.getElementById('localWrap');
const roomList = document.getElementById('roomList');
const currentRoom = document.getElementById('currentRoom');
const currentRoomCount = document.getElementById('currentRoomCount');

const peerId = crypto.randomUUID();
let socket = null;
let roomId = null;
let localStream = null;
let peers = new Map();
let faceDetector = null;
let objectDetector = null;
let joinTime = 0;
let roomsTimer = null;

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

function setVideoVisibility(visible) {
  localWrap.classList.toggle('hidden', !visible);
  remoteGrid.classList.toggle('hidden', !visible);
}

function renderRooms(rooms) {
  roomList.innerHTML = '';
  if (!rooms.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No active rooms';
    roomList.appendChild(li);
    return;
  }

  for (const room of rooms) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    const count = document.createElement('span');
    name.textContent = room.roomId;
    count.textContent = `${room.participants}`;
    li.appendChild(name);
    li.appendChild(count);
    roomList.appendChild(li);
  }
}

async function refreshRooms() {
  try {
    const res = await fetch('/rooms');
    if (!res.ok) return;
    const data = await res.json();
    renderRooms(data.rooms || []);
    if (roomId) {
      const current = (data.rooms || []).find((room) => room.roomId === roomId);
      currentRoom.textContent = roomId;
      currentRoomCount.textContent = current ? String(current.participants) : '0';
    } else {
      currentRoom.textContent = 'Not joined';
      currentRoomCount.textContent = '0';
    }
  } catch {
    // ignore fetch errors
  }
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

async function setupObjectDetector() {
  try {
    const { FilesetResolver, ObjectDetector } = window;
    if (!FilesetResolver || !ObjectDetector) {
      console.warn('MediaPipe Tasks Vision not available');
      return;
    }

    // Pin to v0.10.14 for stability (latest stable version as of implementation)
    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
    );

    objectDetector = await ObjectDetector.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-tasks/object_detector/efficientdet_lite0_uint8.tflite",
      },
      scoreThreshold: 0.5,
      runningMode: "VIDEO",
    });
  } catch (err) {
    console.warn('Failed to initialize ObjectDetector', err);
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

function drawDetections(canvas, result) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const detections = result?.detections ?? [];
  for (const det of detections) {
    const box = det.boundingBox;
    if (!box) continue;

    const cat = det.categories?.[0];
    const label = cat?.categoryName ?? "object";
    const score = typeof cat?.score === "number" ? cat.score : 0;

    // Box
    ctx.lineWidth = 3;
    ctx.strokeStyle = "lime";
    ctx.strokeRect(box.originX, box.originY, box.width, box.height);

    // Label background
    const text = `${label} ${(score * 100).toFixed(1)}%`;
    ctx.font = "16px system-ui, sans-serif";
    const tw = ctx.measureText(text).width;
    const tx = Math.max(0, box.originX);
    const ty = Math.max(18, box.originY);

    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(tx, ty - 18, tw + 10, 22);

    // Label text
    ctx.fillStyle = "white";
    ctx.fillText(text, tx + 5, ty - 2);
  }
}

// Compatibility wrapper for detectForVideo API.
// MediaPipe Tasks Vision v0.10.8+ requires timestampMs for VIDEO mode.
// This wrapper provides defensive coding in case the API signature varies across versions.
function detectForVideoCompat(detector, input, timestampMs) {
  if (detector.detectForVideo.length >= 2) return detector.detectForVideo(input, timestampMs);
  return detector.detectForVideo(input);
}

function startFaceLoop(video, canvas) {
  // Prefer object detection over face detection
  if (objectDetector) {
    startObjectLoop(video, canvas);
  } else if (faceDetector) {
    startFaceDetectionLoop(video, canvas);
  } else {
    // Only update the local status when handling the local video/canvas
    if (video === localVideo) {
      logStatus(localStatus, 'No detection API supported in this browser');
    }
  }
}

function startObjectLoop(video, canvas) {
  let lastVideoTime = -1;

  const loop = () => {
    if (video.readyState < 2) {
      scheduleNext();
      return;
    }

    ensureCanvasSize(video, canvas);

    if (video.currentTime !== lastVideoTime) {
      try {
        const t = performance.now();
        const result = detectForVideoCompat(objectDetector, video, t);
        drawDetections(canvas, result);
        lastVideoTime = video.currentTime;
      } catch (err) {
        // Ignore transient detection errors (video state issues)
        // Log unexpected errors for debugging
        console.debug('ObjectDetector error:', err.message || err);
      }
    }

    scheduleNext();
  };

  const scheduleNext = () => {
    if (typeof video.requestVideoFrameCallback === 'function') {
      video.requestVideoFrameCallback(loop);
    } else {
      // Fallback to ~8 FPS when requestVideoFrameCallback is unavailable
      setTimeout(loop, 120);
    }
  };

  scheduleNext();
}

function startFaceDetectionLoop(video, canvas) {
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
      // Fallback to ~8 FPS when requestVideoFrameCallback is unavailable
      setTimeout(loop, 120);
    }
  };

  scheduleNext();
}

function isPolitePeer(remoteId) {
  if (remoteId === 'server-bot') return false;
  return peerId < remoteId;
}

function createPeerConnection(remoteId) {
  const pc = new RTCPeerConnection(rtcConfig);

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  console.log('[pc] addTrack', remoteId, localStream.getTracks().map((t) => t.kind));

  let makingOffer = false;
  let ignoreOffer = false;

  pc.onsignalingstatechange = () => {
    console.log('[pc] signalingState', remoteId, pc.signalingState);
  };

  pc.onnegotiationneeded = async () => {
    if (!isPolitePeer(remoteId)) return;
    try {
      makingOffer = true;
      const offer = await pc.createOffer();
      if (pc.signalingState !== 'stable') return;
      await pc.setLocalDescription(offer);
      console.log('[pc] send offer', remoteId, 'negotiationneeded');
      socket.send(JSON.stringify({
        type: 'signal',
        to: remoteId,
        data: { sdp: pc.localDescription }
      }));
    } catch (err) {
      console.warn('[pc] negotiationneeded failed', remoteId, err);
    } finally {
      makingOffer = false;
    }
  };

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
    let [stream] = event.streams;
    if (!stream) {
      const entry = peers.get(remoteId);
      if (entry && entry.stream) {
        entry.stream.addTrack(event.track);
        stream = entry.stream;
      } else {
        stream = new MediaStream([event.track]);
      }
    }
    console.log('[pc] ontrack', remoteId, event.track.kind, event.track.readyState);

    let entry = peers.get(remoteId);
    if (entry && entry.stream === stream) return;

    if (!entry || !entry.video) {
      const tile = createRemoteTile(remoteId);
      entry = { ...(entry || {}), ...tile, pc, stream };
      peers.set(remoteId, entry);
    } else {
      entry.stream = stream;
      peers.set(remoteId, entry);
    }

    entry.video.srcObject = stream;
    if (entry.video.isConnected) {
      entry.video.play().catch((err) => {
        console.warn('[pc] video.play failed', remoteId, err);
      });
    }

    const track = stream.getVideoTracks()[0];
    if (track) {
      track.addEventListener('unmute', () => {
        console.log('[pc] track unmute', remoteId);
      });
      track.addEventListener('mute', () => {
        console.log('[pc] track mute', remoteId);
      });
      track.addEventListener('unmute', () => {
        startFaceLoop(entry.video, entry.canvas);
      }, { once: true });
    }
  };

  pc.onconnectionstatechange = () => {
    console.log('[pc] connectionState', remoteId, pc.connectionState);
    if (pc.connectionState === 'failed') {
      removePeer(remoteId);
    }
  };
  pc.oniceconnectionstatechange = () => {
    console.log('[pc] iceConnectionState', remoteId, pc.iceConnectionState);
  };

  return {
    pc,
    makingOfferRef: () => makingOffer,
    setIgnoreOffer: (v) => { ignoreOffer = v; },
    getIgnoreOffer: () => ignoreOffer
  };
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
    const pcState = createPeerConnection(from);
    entry = { pc: pcState.pc, pcState };
    peers.set(from, entry);
  }

  const pc = entry.pc;
  const pcState = entry.pcState;

  if (data.sdp) {
    console.log('[pc] recv sdp', from, data.sdp.type, pc.signalingState);
    const offerCollision = data.sdp.type === 'offer' &&
      (pcState.getIgnoreOffer() || pcState.makingOfferRef() || pc.signalingState !== 'stable');
    const polite = isPolitePeer(from);
    if (offerCollision) {
      pcState.setIgnoreOffer(!polite);
      if (!polite) {
        console.warn('[pc] ignoring offer due to collision', from);
        return;
      }
    }
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    if (data.sdp.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      console.log('[pc] send answer', from);
      socket.send(JSON.stringify({
        type: 'signal',
        to: from,
        data: { sdp: pc.localDescription }
      }));
    }
  }

  if (data.candidate) {
    try {
      console.log('[pc] recv candidate', from);
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    } catch {
      // ignore
    }
  }
}

function ensurePeer(remoteId) {
  if (peers.has(remoteId)) return;
  const pcState = createPeerConnection(remoteId);
  peers.set(remoteId, { pc: pcState.pc, pcState });
}

function connectSocket() {
  const wsProtocol = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${wsProtocol}://${location.host}`);

  socket.addEventListener('open', () => {
    console.log('[ws] open');
    socket.send(JSON.stringify({ type: 'join', roomId, peerId }));
    joinTime = Date.now();
  });

  socket.addEventListener('message', async (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === 'peers') {
      console.log('[ws] peers', msg.peers);
      for (const id of msg.peers) {
        ensurePeer(id);
      }
      return;
    }

    if (msg.type === 'peer-joined') {
      console.log('[ws] peer-joined', msg.peerId);
      ensurePeer(msg.peerId);
      return;
    }

    if (msg.type === 'peer-left') {
      console.log('[ws] peer-left', msg.peerId);
      removePeer(msg.peerId);
      return;
    }

    if (msg.type === 'signal') {
      console.log('[ws] signal from', msg.from);
      await handleSignal(msg.from, msg.data);
    }
  });

  socket.addEventListener('close', () => {
    console.log('[ws] close');
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
  await setupObjectDetector();
  await initLocalMedia();
  setVideoVisibility(true);
  connectSocket();
  logStatus(localStatus, `Joined ${roomId}`);
  leaveBtn.disabled = false;
  await refreshRooms();
});

leaveBtn.addEventListener('click', () => {
  cleanup();
  leaveBtn.disabled = true;
  joinBtn.disabled = false;
  logStatus(localStatus, 'Not connected');
  updateRemoteStatus();
  setVideoVisibility(false);
  roomId = null;
  refreshRooms();
});

window.addEventListener('beforeunload', () => {
  cleanup();
});

setVideoVisibility(false);
refreshRooms();
roomsTimer = setInterval(refreshRooms, 3000);
