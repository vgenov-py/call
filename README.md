# Minimal VoIP

A tiny two-party voice-calling app: Python 3 + Flask + Flask-SocketIO for the
backend, SQLite for accounts/call history, vanilla HTML/CSS/JS on the
frontend. No React, no WebRTC, no STUN/TURN, no third-party call service.

## How the "VoIP" part works

There's no peer-to-peer connection and no WebRTC here. Audio goes over a
plain WebSocket (via Flask-SocketIO):

1. Each browser tab opens a Socket.IO connection to the Flask server. That
   same connection is used for login presence, call signaling
   (`call_request` / `call_accept` / `call_reject` / `hangup`), **and** audio.
2. Once a call is active, the browser captures the mic with
   `getUserMedia` + a `ScriptProcessorNode`, converts the Float32 samples to
   16-bit PCM, and emits each ~128ms chunk as a binary Socket.IO event
   (`audio_chunk`).
3. The Flask server does nothing to the audio except look up who the sender
   is currently in a call with, and relay the same binary chunk to that
   peer's socket. It's a dumb relay, not a media server.
4. The receiving browser turns each chunk back into a Float32 `AudioBuffer`
   and schedules it for gapless playback via the Web Audio API's own clock.

This means: every call is relayed through your Flask process (works across
NAT/internet without any STUN/TURN setup), but all audio for all calls also
passes through that one process, so it won't scale past a handful of
simultaneous calls — that's the tradeoff for "no extra service."

## Setup

```bash
python3 -m venv venv
source venv/bin/activate       # Windows: venv\Scripts\activate
pip install -r requirements.txt
python3 app.py
```

Open `http://localhost:5000` in two different browsers (or one normal +
one incognito window), register two different usernames, and call one
from the other.

The SQLite file `voip.db` is created automatically on first run, with a
`users` table and a `call_logs` table (caller/callee/timestamp for every
accepted call).

## Deploying behind nginx + gunicorn

This app keeps all presence/call state in one process's memory (no Redis),
so it must run as a **single process**. Use gunicorn with the `eventlet`
worker class (plain sync workers don't support websockets at all):

```bash
gunicorn -k eventlet -w 1 -b 127.0.0.1:5000 app:app
```

Set `SECRET_KEY` to a fixed value in the environment (systemd unit,
`.env`, etc.) rather than relying on the auto-generated `.secret_key`
file — especially if you ever run more than one instance or wipe the
filesystem between deploys:

```bash
export SECRET_KEY="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
```

nginx must be told to proxy websocket upgrades, or Socket.IO falls back
to polling and behaves worse (and can still break sessions if requests
aren't sticky). Example `server` block:

```nginx
server {
    listen 80;
    server_name call.infofortis.com;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;   # keep long-lived socket connections open
    }
}
```

Then put this behind HTTPS (e.g. `certbot --nginx`) — `getUserMedia`
(microphone access) is blocked by browsers on any non-`localhost` origin
that isn't served over HTTPS, so calling won't work on a plain `http://`
public domain regardless of the backend being fixed.

If you outgrow a single process later (need multiple workers/machines),
that requires adding a message queue (Redis) for Socket.IO and moving
`online_users`/`active_calls` into it too — that's a real architecture
change, not a config tweak.

## Notes / limitations (intentional, given "minimal")

- **Audio format**: raw 16-bit mono PCM at 16kHz, uncompressed — simplest
  to implement with zero external codec libraries. That's roughly
  256 kbit/s per direction. Fine on localhost/LAN; on a slow link you may
  hear stutter. Swapping in Opus via a WASM encoder would fix that later
  without changing the architecture.
- **`ScriptProcessorNode`** is deprecated in favor of `AudioWorklet`, but
  it needs no separate worklet file to load and works in every current
  browser, so it's the simpler starting point. Worth migrating later.
- **Two-party calls only** — `active_calls` is a simple 1:1 mapping, no
  group calls/conferencing.
- **In-memory presence** (`online_users` / `active_calls` dicts) — fine for
  one Flask process; restarting the server drops everyone's "online"
  status until they reload.
- **Socket.IO client from CDN** in `templates/index.html`. If you want
  zero runtime external dependencies, download
  `https://cdn.socket.io/4.7.5/socket.io.min.js`, save it as
  `static/js/socket.io.min.js`, and change the `<script src=...>` tag.
- For production use beyond localhost testing, run behind `eventlet` or
  `gevent` (`pip install eventlet`) instead of the Flask dev server, and
  serve over HTTPS/WSS — browsers require a secure context for
  `getUserMedia` on any origin other than `localhost`.
