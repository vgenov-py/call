const socket = io();

const SAMPLE_RATE = 16000;   // mono, low bandwidth, good enough for voice
const CHUNK_SIZE = 2048;     // ~128ms per chunk at 16kHz

let audioContext = null;
let mediaStream = null;
let micSource = null;
let processor = null;
let silentGain = null;
let nextPlayTime = 0;
let inCall = false;
let muted = false;
let pendingCaller = null;
let wakeLock = null;

const userListEl = document.getElementById("user-list");
const statusEl = document.getElementById("status");
const incomingModal = document.getElementById("incoming-modal");
const incomingFromEl = document.getElementById("incoming-from");
const callControls = document.getElementById("call-controls");
const callPeerEl = document.getElementById("call-peer");
const muteBtn = document.getElementById("mute-btn");
const hangupBtn = document.getElementById("hangup-btn");
const acceptBtn = document.getElementById("accept-btn");
const rejectBtn = document.getElementById("reject-btn");

function setStatus(text, clearAfterMs) {
  statusEl.textContent = text;
  if (clearAfterMs) {
    setTimeout(() => { if (statusEl.textContent === text) statusEl.textContent = ""; }, clearAfterMs);
  }
}

function refreshUsers() {
  fetch("/api/users")
    .then((r) => r.json())
    .then((users) => {
      userListEl.innerHTML = "";
      if (users.length === 0) {
        userListEl.innerHTML = '<li class="empty">No one else is online</li>';
        return;
      }
      users.forEach((u) => {
        const li = document.createElement("li");
        const name = document.createElement("span");
        name.textContent = u;
        const btn = document.createElement("button");
        btn.className = "btn";
        btn.textContent = "Call";
        btn.disabled = inCall;
        btn.addEventListener("click", () => {
          if (inCall) return;
          socket.emit("call_request", { to: u });
          setStatus(`Calling ${u}…`);
        });
        li.append(name, btn);
        userListEl.appendChild(li);
      });
    });
}

socket.on("presence", refreshUsers);

socket.on("incoming_call", (data) => {
  pendingCaller = data.from;
  incomingFromEl.textContent = data.from;
  incomingModal.classList.remove("hidden");
});

acceptBtn.addEventListener("click", () => {
  incomingModal.classList.add("hidden");
  socket.emit("call_accept", { caller: pendingCaller });
  pendingCaller = null;
});

rejectBtn.addEventListener("click", () => {
  incomingModal.classList.add("hidden");
  socket.emit("call_reject", { caller: pendingCaller });
  pendingCaller = null;
});

socket.on("call_rejected", (data) => setStatus(`${data.by} rejected the call`, 3000));
socket.on("call_failed", (data) => setStatus(`Call failed: ${data.reason}`, 3000));
socket.on("call_started", (data) => startCall(data.peer));
socket.on("call_ended", (data) => {
  endCall();
  setStatus(data.reason || "Call ended", 3000);
});

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return; // unsupported browser — silently skip
  try {
    wakeLock = await navigator.wakeLock.request("screen");
  } catch (err) {
    // Can fail if the tab isn't visible/focused at the moment of the call,
    // or the OS refuses it — not fatal, the call still works.
    wakeLock = null;
  }
}

async function releaseWakeLock() {
  if (wakeLock) {
    try { await wakeLock.release(); } catch (err) { /* already released */ }
    wakeLock = null;
  }
}

// The wake lock is auto-released by the browser whenever the tab is hidden
// (app-switch, screen lock). If the call is still going when the tab
// becomes visible again, re-acquire it so the screen stays on again.
document.addEventListener("visibilitychange", () => {
  if (inCall && document.visibilityState === "visible" && !wakeLock) {
    requestWakeLock();
  }
});
async function startNativeAudioSession() {
  if (window.Capacitor?.isNativePlatform()) {
    try {
      await window.Capacitor.Plugins.AudioSession.start();
    } catch (e) {
      console.warn('Native audio session start failed:', e?.message || e?.code || String(e));
    }
  }
}

async function stopNativeAudioSession() {
  if (window.Capacitor?.isNativePlatform()) {
    try {
      await window.Capacitor.Plugins.AudioSession.stop();
    } catch (e) {
      console.warn('Native audio session stop failed:', e?.message || e?.code || String(e));
    }
  }
}

async function startCall(peer) {
  await startNativeAudioSession();

  inCall = true;
  callPeerEl.textContent = peer;
  callControls.classList.remove("hidden");
  setStatus("");
  refreshUsers();

  audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
  nextPlayTime = audioContext.currentTime;

  requestWakeLock();

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: SAMPLE_RATE,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (err) {
    setStatus("Microphone access denied");
    socket.emit("hangup");
    endCall();
    return;
  }

  micSource = audioContext.createMediaStreamSource(mediaStream);
  processor = audioContext.createScriptProcessor(CHUNK_SIZE, 1, 1);

  // ScriptProcessorNode only fires if it's connected to a destination, but we
  // don't want to hear our own mic — route it through a silent gain node.
  silentGain = audioContext.createGain();
  silentGain.gain.value = 0;
  micSource.connect(processor);
  processor.connect(silentGain);
  silentGain.connect(audioContext.destination);

  processor.onaudioprocess = (e) => {
    if (muted || !inCall) return;
    const input = e.inputBuffer.getChannelData(0);
    const int16 = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    socket.emit("audio_chunk", int16.buffer);
  };
}

socket.on("audio_chunk", (data) => {
  if (!audioContext || !inCall) return;
  const int16 = new Int16Array(data);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7fff);
  }
  const buffer = audioContext.createBuffer(1, float32.length, SAMPLE_RATE);
  buffer.copyToChannel(float32, 0);
  const src = audioContext.createBufferSource();
  src.buffer = buffer;
  src.connect(audioContext.destination);

  const now = audioContext.currentTime;
  if (nextPlayTime < now) nextPlayTime = now + 0.05; // resync if we fell behind
  src.start(nextPlayTime);
  nextPlayTime += buffer.duration;
});

muteBtn.addEventListener("click", () => {
  muted = !muted;
  muteBtn.textContent = muted ? "Unmute" : "Mute";
});

hangupBtn.addEventListener("click", () => {
  socket.emit("hangup");
  endCall();
});

function endCall() {
  inCall = false;
  callControls.classList.add("hidden");
  muted = false;
  muteBtn.textContent = "Mute";
  releaseWakeLock();

  if (processor) {
    processor.onaudioprocess = null;
    processor.disconnect();
    processor = null;
  }
  if (silentGain) { silentGain.disconnect(); silentGain = null; }
  if (micSource) { micSource.disconnect(); micSource = null; }
  if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; }
  if (audioContext) { audioContext.close(); audioContext = null; }

  stopNativeAudioSession();

  refreshUsers();
}

refreshUsers();
setInterval(refreshUsers, 4000);
