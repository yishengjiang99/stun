# Feature Plan: Server-Side WebRTC Participant (Demo Room)

## Goal
Add a server-side participant that auto-joins the default `demo-room` and streams a sample video to other peers. When users join `demo-room`, they should see this server participant as a remote peer.

## Scope
- Implement a Node.js WebRTC peer that connects through the existing signaling server.
- The peer will publish a single video track sourced from a sample file or generated stream.
- The peer will automatically join `demo-room` on server startup.

## Assumptions
- We can run a Node process with WebRTC support (e.g., `wrtc` or equivalent).
- We can provide a sample video file on the server.
- The signaling server remains unchanged or only minimally adjusted.

## High-Level Design
1. **Server-side peer**
   - New Node module (`server-peer.js`) creates a `RTCPeerConnection` using `wrtc`.
   - Connects to signaling server via WebSocket and joins `demo-room` with a fixed `peerId` (e.g., `server-bot`).
   - Implements the same signaling protocol (`join`, `signal`) as browser clients.

2. **Media source**
   - Use a sample video file (e.g., `assets/demo.mp4`).
   - Decode video to frames and feed into a `MediaStreamTrack` (via `wrtc` + `node-webrtc` track APIs or `wrtc` + `node-canvas`/`ffmpeg` pipeline).
   - If file-based streaming is too heavy, use a generated test pattern (color bars) as a fallback.

3. **Signaling flow**
   - On join, the server peer will handle offers/answers and ICE candidates.
   - Reuse the polite peer / glare handling logic similar to the browser client.

4. **Lifecycle**
   - Start server peer alongside the signaling server (same process or separate service).
   - Reconnect on failure or WS disconnect.

## Implementation Steps
1. Add dependencies:
   - `wrtc` (or `@koush/wrtc` if needed for Node version compatibility)
   - Optional: `ffmpeg-static`, `fluent-ffmpeg`, or `node-canvas` for video source
2. Create `server-peer.js`:
   - Implement signaling client and RTCPeerConnection logic
   - Load sample video and publish track
3. Add sample video file under `public/` or `assets/` (server-only access recommended)
4. Add startup hook:
   - Start server peer when server starts (or as separate process via systemd)
5. Add logs and health checks

## Testing Plan
- Local: open two browsers to `demo-room` and confirm the server video appears as a remote peer.
- Remote: access over HTTPS and confirm stable playback.
- Verify reconnection logic if the server peer restarts.

## Risks / Open Questions
- Node WebRTC dependencies can be fragile across Node versions.
- CPU usage for video decoding/encoding may be high.
- Need to decide if server peer should run in the same process or as a separate service.

## Acceptance Criteria
- Joining `demo-room` shows a remote peer named `server-bot` (or similar).
- The remote video is visible and stable for all clients.
- The server peer reconnects automatically on transient failures.
