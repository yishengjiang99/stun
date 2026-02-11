# Plan: Replace `server-peer.js` with Janus Integration

## Goal
Use Janus as the media server to provide the sample video feed instead of a Node.js WebRTC peer. The web app should connect to Janus for the demo-room “server bot” stream, while keeping the existing signaling server for peer discovery and p2p connections.

## Why Janus
- Stable SFU/media server implementation
- Handles media ingestion and distribution efficiently
- Avoids `wrtc` + raw frame pipeline complexity on the Node side

## High-Level Approach
1. **Deploy Janus** (Docker or native install) with:
   - WebSockets enabled
   - VideoRoom plugin enabled
2. **Ingest sample video** into Janus as a publisher
   - Use `ffmpeg` + `janus-pp` or RTP ingestion
3. **Client subscribes** to the Janus VideoRoom feed
   - Add Janus JS client integration
   - Render Janus feed in a dedicated “Server Bot” remote tile
4. **Keep existing signaling** for peer discovery between browsers

## Architecture
- **Existing signaling server** remains for P2P peers.
- **Janus** handles “server-bot” media only.
- **Client** connects to both:
  - WS -> signaling server (existing)
  - WS -> Janus (new)

## Integration Steps
1. **Provision Janus**
   - **Option A: Docker (recommended)**
     - Pull Janus Docker image and run with WebSockets enabled.
   - **Option B: Native install (Ubuntu)**
     - Install Janus from packages or build from source with WebSockets.

2. **Enable Janus WebSockets**
   - Ensure WebSocket transport is enabled (`janus.transport.websockets`).
   - Expose a WS endpoint:
     - `ws://<host>:8188` (plain)
     - `wss://<host>/janus` (via nginx TLS proxy)

3. **Create a VideoRoom**
   - Configure a static room in `janus.plugin.videoroom`:
     - `room_id=1234`
     - `publishers=1`
     - `bitrate` (e.g., 1–2 Mbps)
     - `videocodec=vp8` or `h264`

4. **Ingest Sample Video**
   - Use `ffmpeg` to push RTP into Janus (recommended):
     - Configure VideoRoom RTP forward or mount
     - Or use the Janus streaming plugin as a video source

5. **Client Integration**
   - Add Janus JS library
   - Connect to Janus in parallel to the signaling server
   - Attach to VideoRoom as subscriber
   - Render Janus stream in a “Server Bot” tile

6. **Fallback / Error Handling**
   - If Janus unavailable, hide the tile and show a status message

## Concrete Steps (Docker + nginx)

### 1) Run Janus with WebSockets

```bash
docker run -d --name janus \\
  -p 8188:8188 \\
  -p 8088:8088 \\
  meetecho/janus-gateway
```

Default Janus config uses:
- WebSockets on `8188`
- HTTP on `8088`

**Troubleshooting**:
```bash
docker logs -f janus
```

### 2) Add nginx reverse proxy (optional TLS)

```
location /janus/ {
  proxy_pass http://127.0.0.1:8188/;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
}
```

**Note**: If your site is HTTPS, use `wss://` in the client.

### 3) Create a static VideoRoom

Edit `janus.plugin.videoroom.jcfg`:

```
rooms: [
  {
    room_id: 1234
    description: "Server bot room"
    publishers: 1
    bitrate: 1500000
    videocodec: "vp8"
  }
]
```

Restart Janus after changes.

### 4) Ingest sample video to Janus (Streaming plugin)

Create a streaming mount (example, `janus.plugin.streaming.jcfg`):

```
streaming: {
  mountpoints: [
    {
      id = 1
      name = "server-bot"
      description = "Server bot sample"
      audio = false
      video = true
      videoport = 5004
      videopt = 96
      videocodec = "vp8"
    }
  ]
}
```

Then push RTP into Janus:

```bash
ffmpeg -re -stream_loop -1 -i /path/to/demo.mp4 \\
  -an -c:v libvpx -b:v 1M -g 60 -keyint_min 60 \\
  -f rtp rtp://127.0.0.1:5004
```

**Verify RTP reception**:
- Use `tcpdump -n udp port 5004` to confirm packets.
- Check Janus logs for the streaming mount becoming active.

### 5) Client integration outline

- Add Janus JS client to `public/` or bundle.
- On join:
  - Create Janus session
  - Attach to streaming or videoroom plugin
  - Subscribe to mount/room
  - Render stream in a dedicated tile

**Pseudo-code (Streaming plugin)**:
```js
const janus = new Janus({
  server: 'wss://p2p.grepawk.com/janus',
  success: () => {
    janus.attach({
      plugin: 'janus.plugin.streaming',
      success: (pluginHandle) => {
        pluginHandle.send({ message: { request: 'watch', id: 1 } });
      },
      onmessage: (msg, jsep) => {
        if (jsep) {
          pluginHandle.createAnswer({
            jsep,
            media: { audioSend: false, videoSend: false },
            success: (jsepAnswer) => {
              pluginHandle.send({ message: { request: 'start' }, jsep: jsepAnswer });
            }
          });
        }
      },
      onremotestream: (stream) => {
        // attach stream to “Server Bot” video element
      }
    });
  }
});
```

### 6) CORS / HTTPS Notes
- If your site is HTTPS, Janus must be reachable over `wss`.
- Use nginx to terminate TLS and forward to Janus WS.
- Avoid mixed content by aligning protocols.

### 7) Firewall
- Allow inbound TCP 443 (HTTPS) and 80 (optional).
- If exposing Janus directly: allow TCP 8188 and 8088.
- If using RTP ingest: allow UDP for the RTP port(s) (e.g., 5004).

### 8) Decommission `server-peer.js`
- Keep it until Janus is stable in production.
- Remove from systemd and repo once Janus works.

## Concrete Steps (Ubuntu Native Install)

### 1) Install dependencies
```bash
sudo apt update
sudo apt install -y \
  git build-essential cmake pkg-config libssl-dev libjansson-dev \
  libglib2.0-dev libnice-dev libmicrohttpd-dev libwebsockets-dev \
  libopus-dev libogg-dev libcurl4-openssl-dev libconfig-dev \
  libavutil-dev libavcodec-dev libavformat-dev libavfilter-dev \
  libswscale-dev ffmpeg
```

### 2) Build and install Janus
```bash
git clone https://github.com/meetecho/janus-gateway.git
cd janus-gateway
sh autogen.sh
./configure --prefix=/opt/janus --enable-websockets --enable-post-processing
make -j"$(nproc)"
sudo make install
sudo make configs
```

### 3) Enable WebSockets
Edit `/opt/janus/etc/janus/janus.transport.websockets.jcfg`:
```
general: {
  ws = true
  wss = false
  ws_port = 8188
}
```

### 4) Configure VideoRoom
Edit `/opt/janus/etc/janus/janus.plugin.videoroom.jcfg`:
```
rooms: [
  {
    room_id: 1234
    description: "Server bot room"
    publishers: 1
    bitrate: 1500000
    videocodec: "vp8"
  }
]
```

### 5) Configure Streaming plugin (RTP ingest)
Edit `/opt/janus/etc/janus/janus.plugin.streaming.jcfg`:
```
streaming: {
  mountpoints: [
    {
      id = 1
      name = "server-bot"
      description = "Server bot sample"
      audio = false
      video = true
      videoport = 5004
      videopt = 96
      videocodec = "vp8"
    }
  ]
}
```

### 6) Start Janus
```bash
/opt/janus/bin/janus
```

### 7) (Optional) Run Janus as a systemd service
Create `/etc/systemd/system/janus.service`:
```
[Unit]
Description=Janus WebRTC Gateway
After=network.target

[Service]
Type=simple
ExecStart=/opt/janus/bin/janus
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Enable it:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now janus
sudo systemctl status janus
```

### 8) Push sample video into Janus
```bash
ffmpeg -re -stream_loop -1 -i /path/to/demo.mp4 \
  -an -c:v libvpx -b:v 1M -g 60 -keyint_min 60 \
  -f rtp rtp://127.0.0.1:5004
```

### 9) Verify ports
```bash
ss -lntp | grep 8188
ss -lunp | grep 5004
```

## Client Integration Outline

### Goal
Subscribe to a Janus Streaming mount (id `1`) and render it as the “Server Bot” tile while keeping P2P signaling as-is.

### Steps
1. Include Janus JS library in `public/` (or bundle it).
2. Create a Janus session on join.
3. Attach to `janus.plugin.streaming`.
4. Send `watch` request for mount `id: 1`.
5. On `jsep`, create an answer with recvonly.
6. Attach remote stream to a dedicated video element.

### Pseudo-code
```js
const janus = new Janus({
  server: 'wss://p2p.grepawk.com/janus',
  success: () => {
    janus.attach({
      plugin: 'janus.plugin.streaming',
      success: (pluginHandle) => {
        pluginHandle.send({ message: { request: 'watch', id: 1 } });
      },
      onmessage: (msg, jsep) => {
        if (jsep) {
          pluginHandle.createAnswer({
            jsep,
            media: { audioSend: false, videoSend: false },
            success: (jsepAnswer) => {
              pluginHandle.send({ message: { request: 'start' }, jsep: jsepAnswer });
            }
          });
        }
      },
      onremotestream: (stream) => {
        // attach to server-bot video element
      }
    });
  }
});
```
## Open Questions
- Should Janus run on same host as signaling server?
- Do we need TLS termination for Janus WS (wss)?
- Should Janus be private/internal with reverse proxy?

## Acceptance Criteria
- Joining `demo-room` shows a “Server Bot” video from Janus.
- P2P peer connections still function as before.
- No `server-peer.js` required in production.

## Rollout Plan
1. Stand up Janus in staging.
2. Wire client to Janus in a feature flag.
3. Remove `server-peer.js` once stable.
