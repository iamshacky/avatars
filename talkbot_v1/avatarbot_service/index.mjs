import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { AccessToken } from "livekit-server-sdk";
import {
  Room,
  AudioSource,
  LocalAudioTrack,
  TrackPublishOptions,
  TrackSource,
  AudioFrame,
} from "@livekit/rtc-node";
import { decode } from "node-wav";

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ── ENV ────────────────────────────────────────────────────────────────────────
const {
  LIVEKIT_URL,
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET,
  OPENAI_API_KEY,
  DEFAULT_ROOM = "default",
  BOT_IDENTITY = "AvatarBot_1",
  BOT_MODE = "TRANSIENT", // or PERSISTENT
  OPENAI_TTS_MODEL = "gpt-4o-mini-tts",
  OPENAI_TTS_VOICE = "alloy",
  CLIENT_TOKEN_TTL_MIN = 60,
} = process.env;

if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  console.error("Missing LiveKit env vars.");
  process.exit(1);
}
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY.");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ── APP & STATIC ──────────────────────────────────────────────────────────────
const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pubDir = path.join(__dirname, "public");

app.use(cors());
app.use(express.json());
app.use(express.static(pubDir));
app.get("/", (_req, res) => res.sendFile(path.join(pubDir, "index.html")));

app.get("/__debug/files", (_req, res) => {
  const exists = fs.existsSync(pubDir);
  const listing = exists ? fs.readdirSync(pubDir) : [];
  res.json({ __dirname, pubDir, exists, listing });
});

// 🔐 optional shared-secret guard
app.use((req, res, next) => {
  const needsAuth =
    req.method === "POST" &&
    ["/message", "/join", "/leave", "/mode", "/diag/tone", "/diag/silence", "/diag/tone_hold", "/diag/silence_hold"].includes(req.path);
  if (!needsAuth) return next();
  const provided = req.headers["x-bot-auth"];
  if (!process.env.BOT_AUTH || provided === process.env.BOT_AUTH) return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
});

// ── LIVEKIT HELPERS ───────────────────────────────────────────────────────────
function mintServerToken({ roomName, identity, canPublish = true }) {
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity,
    ttl: "60m",
  });
  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish,
    canSubscribe: true,
  });
  return at.toJwt();
}

function wireRoom(room) {
  room.__lkState = { connected: true, lastError: null };
  room.on?.("connected", () => { room.__lkState.connected = true; console.log("LK room connected"); });
  room.on?.("disconnected", () => { room.__lkState.connected = false; console.log("LK room disconnected"); });
  room.on?.("reconnecting", () => console.log("LK room reconnecting"));
  room.on?.("reconnected", () => console.log("LK room reconnected"));
  room.on?.("connectionStateChanged", (s) => console.log("LK conn state:", s));
  room.on?.("participantConnected", (p) => console.log("LK participant+", p?.identity));
  room.on?.("participantDisconnected", (p) => console.log("LK participant-", p?.identity));
  room.on?.("trackPublished", (pub) => console.log("LK trackPublished", pub?.trackSid || pub?.sid || pub?.trackName));
  room.on?.("trackUnpublished", (pub) => console.log("LK trackUnpublished", pub?.trackSid || pub?.sid || pub?.trackName));
  room.on?.("engineError", (e) => { room.__lkState.lastError = e; console.warn("LK engineError:", e?.message || String(e)); });
  return room;
}

async function connectToRoom(roomName, identity = BOT_IDENTITY) {
  const room = new Room();
  const token = await mintServerToken({ roomName, identity, canPublish: true });
  console.log("Connecting to LiveKit", { url: LIVEKIT_URL, room: roomName, identity });
  await room.connect(LIVEKIT_URL, token);
  wireRoom(room);
  console.log("Connected to LiveKit", { roomName, identity: room.localParticipant?.identity });
  return room;
}

function isRoomUsable(room) {
  if (!room) return false;
  if (room.__lkState && room.__lkState.connected) return true;
  return !!room.localParticipant;
}

async function ensurePersistentRoom(roomName) {
  if (persistent?.room && isRoomUsable(persistent.room)) return persistent.room;
  const room = await connectToRoom(roomName);
  persistent = { room, roomName };
  return room;
}

async function safeUnpublish(room, publication, track) {
  if (!room?.localParticipant?.unpublishTrack) {
    console.warn("localParticipant.unpublishTrack not available");
    return;
  }
  const sid =
    publication?.trackSid ??
    publication?.sid ??
    (typeof publication?.toJSON === "function" ? publication.toJSON()?.sid : undefined);

  const attempts = [
    () => sid && room.localParticipant.unpublishTrack(sid, { stopOnUnpublish: true }),
    () => sid && room.localParticipant.unpublishTrack(sid, true),
    () => room.localParticipant.unpublishTrack(track, { stopOnUnpublish: true }),
    () => room.localParticipant.unpublishTrack(track, true),
    () => publication && room.localParticipant.unpublishTrack(publication, { stopOnUnpublish: true }),
  ];

  let lastErr = null;
  for (const tryIt of attempts) {
    try {
      const p = tryIt();
      if (!p) continue;
      await p;
      console.log("unpublishTrack: success");
      return;
    } catch (e) {
      lastErr = e;
      console.warn("unpublishTrack signature failed:", e?.message || String(e));
    }
  }
  console.warn("unpublishTrack: all signatures failed; continuing", lastErr?.message || lastErr);
}

// ── AUDIO: WAV → 48k PCM FRAMES ───────────────────────────────────────────────
async function wavToInt16Frames(wavBuf, desiredFrameMs = 20) {
  const { sampleRate: srcRate, channelData } = await decode(wavBuf);
  const channels = channelData.length;
  const ch0 = channelData[0];

  // downmix to mono if needed
  let mono;
  if (channels === 1) {
    mono = ch0;
  } else {
    const len = channelData[0].length;
    mono = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      let acc = 0;
      for (let c = 0; c < channels; c++) acc += channelData[c][i];
      mono[i] = acc / channels;
    }
  }

  // float32 → int16
  const pcm16src = new Int16Array(mono.length);
  for (let i = 0; i < mono.length; i++) {
    const s = Math.max(-1, Math.min(1, mono[i]));
    pcm16src[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }

  // resample to 48 kHz if needed
  const dstRate = 48000;
  let pcm16 = pcm16src;
  let rate = srcRate;
  if (srcRate !== dstRate) {
    const ratio = dstRate / srcRate;
    const dstLen = Math.round(pcm16src.length * ratio);
    const out = new Int16Array(dstLen);
    for (let i = 0; i < dstLen; i++) {
      const srcIndex = i / ratio;
      const i0 = Math.floor(srcIndex);
      const i1 = Math.min(i0 + 1, pcm16src.length - 1);
      const frac = srcIndex - i0;
      const s0 = pcm16src[i0];
      const s1 = pcm16src[i1];
      out[i] = s0 + (s1 - s0) * frac;
    }
    pcm16 = out;
    rate = dstRate;
  }

  // frame into 20ms chunks
  const samplesPerFrame = Math.floor((rate * desiredFrameMs) / 1000); // 960 @ 48kHz
  const frames = [];
  for (let offset = 0; offset < pcm16.length; offset += samplesPerFrame) {
    const slice = pcm16.subarray(offset, Math.min(offset + samplesPerFrame, pcm16.length));
    const buf = Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength);
    frames.push({ buf, sampleRate: rate, samplesPerChannel: slice.length, numChannels: 1 });
  }
  return { frames, sampleRate: rate, channels: 1 };
}

// ── TTS (OpenAI) ─────────────────────────────────────────────────────────────
async function ttsWavFromOpenAI(text) {
  const t0 = Date.now();
  const resp = await openai.audio.speech.create({
    model: OPENAI_TTS_MODEL,
    voice: OPENAI_TTS_VOICE,
    input: text,
    response_format: "wav",
  });
  const wavBuf = Buffer.from(await resp.arrayBuffer());
  console.log("TTS ms:", Date.now() - t0, "bytes:", wavBuf?.length || 0);
  if (!wavBuf || wavBuf.length < 44) throw new Error("TTS returned empty/invalid WAV");
  return wavBuf;
}

// ── SPEAK: TTS → PUBLISH → pre-roll → tail → UNPUBLISH ───────────────────────
async function publishFramesOnce(room, frames, sampleRate, trackName = "avatar-audio") {
  const source = new AudioSource(sampleRate, 1);
  const track = LocalAudioTrack.createAudioTrack(trackName, source);
  const options = new TrackPublishOptions();
  options.source = TrackSource.SOURCE_MICROPHONE;

  const publication = await room.localParticipant.publishTrack(track, options);

  // Give the SFU a moment to announce the new track before frames start
  await new Promise((r) => setTimeout(r, 150));

  console.log("Published audio track", {
    identity: room.localParticipant?.identity,
    publication: {
      sid: publication?.trackSid ?? publication?.sid,
      name: publication?.trackName || trackName,
    },
  });
  console.log("About to publish frames", {
    by: room?.localParticipant?.identity,
    totalFrames: frames.length,
    sampleRate,
    samplesPerFrame: Math.floor((sampleRate * 20) / 1000),
  });

  const frameMs = 20;
  const samplesPerFrame = Math.floor((sampleRate * frameMs) / 1000);

  // PRE-ROLL silence (↑ 1500ms) so subscribers attach before first phoneme
  for (let i = 0; i < Math.ceil(1500 / frameMs); i++) {
    const pcm = new Int16Array(samplesPerFrame);
    const buf = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const frame = new AudioFrame(buf, sampleRate, 1, samplesPerFrame);
    await source.captureFrame(frame);
  }

  // actual TTS frames
  for (const f of frames) {
    const frame = new AudioFrame(f.buf, f.sampleRate, f.numChannels, f.samplesPerChannel);
    await source.captureFrame(frame);
  }

  // quick RMS sanity (keep your block here)

  // TAIL silence (↑ 3000ms) so late subscribers still hear the ending
  for (let i = 0; i < Math.ceil(3000 / frameMs); i++) {
    const pcm = new Int16Array(samplesPerFrame);
    const buf = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const frame = new AudioFrame(buf, sampleRate, 1, samplesPerFrame);
    await source.captureFrame(frame);
  }

  // quick sanity: estimate RMS amplitude of the last frame (int16)
  try {
    const last = frames[frames.length - 1];
    if (last?.buf?.byteLength) {
      const i16 = new Int16Array(last.buf.buffer, last.buf.byteOffset, last.buf.byteLength / 2);
      let sum = 0;
      for (let i = 0; i < i16.length; i++) { const v = i16[i] / 32768; sum += v * v; }
      const rms = Math.sqrt(sum / i16.length);
      console.log("Last-frame RMS (0..1):", rms.toFixed(4));
    }
  } catch {}

  await safeUnpublish(room, publication, track);
  try { if (typeof track.stop === "function") track.stop(); } catch {}
  try { if (typeof source.stop === "function") source.stop(); } catch {}
}

async function speakTextIntoRoom(roomOrName, text, opts = {}) {
  // opts: { roomName?: string, identity?: string }
  const wavBuf = await ttsWavFromOpenAI(text);
  const { frames, sampleRate } = await wavToInt16Frames(wavBuf, 20);

  let room = typeof roomOrName === "string" ? await ensurePersistentRoom(roomOrName) : roomOrName;
  const targetRoomName = typeof roomOrName === "string" ? roomOrName : (opts.roomName || DEFAULT_ROOM);
  const targetIdentity = typeof roomOrName === "string" ? BOT_IDENTITY : (opts.identity || room?.localParticipant?.identity || BOT_IDENTITY);

  try {
    await publishFramesOnce(room, frames, sampleRate);
  } catch (e) {
    const msg = String(e || "");
    console.warn("publish failed, first attempt:", msg);
    if (msg.includes("engine is closed") || msg.includes("connection error")) {
      try { await room.disconnect().catch(() => {}); } catch {}
      room = await connectToRoom(targetRoomName, targetIdentity);
      await publishFramesOnce(room, frames, sampleRate);
    } else {
      throw e;
    }
  }
}

// ── LLM ───────────────────────────────────────────────────────────────────────
async function llmReply(userText) {
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "You are AvatarBot_1: concise, friendly, YouTube-presenter energy. Keep answers under 15 seconds unless asked." },
      { role: "user", content: userText },
    ],
  });
  return res.choices?.[0]?.message?.content ?? "Sorry, I couldn't think of anything to say.";
}

// ── ROUTES ────────────────────────────────────────────────────────────────────
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, mode: process.env.BOT_MODE || BOT_MODE, room: DEFAULT_ROOM, tts: { provider: "openai", model: OPENAI_TTS_MODEL, voice: OPENAI_TTS_VOICE } });
});

app.get("/diag/state", (_req, res) => {
  const st = persistent?.room?.__lkState || null;
  res.json({ persistent: !!persistent?.room, state: st });
});

app.post("/mode", (req, res) => {
  const { mode } = req.body || {};
  if (mode && ["TRANSIENT", "PERSISTENT"].includes(mode)) {
    process.env.BOT_MODE = mode;
    res.json({ ok: true, mode });
  } else {
    res.status(400).json({ ok: false, error: "mode must be TRANSIENT or PERSISTENT" });
  }
});

let persistent = null; // { room: Room, roomName: string }

// Prevent overlapping speaks from colliding / crashing the process
let speakQueue = Promise.resolve();
function enqueueSpeak(fn) {
  // `fn` must be an async function
  speakQueue = speakQueue.then(fn).catch((e) => {
    console.warn("speakQueue task error:", e?.message || e);
  });
  return speakQueue;
}


app.post("/join", async (req, res) => {
  const roomName = req.body?.roomName || DEFAULT_ROOM;
  try {
    await ensurePersistentRoom(roomName);
    res.json({ ok: true, roomName });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post("/leave", async (_req, res) => {
  try {
    if (persistent?.room) {
      await persistent.room.disconnect();
      persistent = null;
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post("/message", async (req, res) => {
  const roomName = req.body?.roomName || DEFAULT_ROOM;
  const textIn = String(req.body?.text || "").trim();
  const keep = req.body?.keep;
  if (!textIn) return res.status(400).json({ ok: false, error: "text required" });

  const mode = keep === true || keep === false
    ? (keep ? "PERSISTENT" : "TRANSIENT")
    : (process.env.BOT_MODE || BOT_MODE);

  try {
    const t0 = Date.now();
    const reply = await llmReply(textIn);
    console.log("LLM ms:", Date.now() - t0);

    // enqueue the speak so HTTP returns immediately (no 502s)
    const roomName0 = roomName;
    if (mode === "PERSISTENT") {
      enqueueSpeak(async () => {
        const room = await ensurePersistentRoom(roomName0);
        console.log("PERSISTENT speak starting, identity:", room.localParticipant?.identity);
        await speakTextIntoRoom(room, reply, { roomName: roomName0, identity: room.localParticipant?.identity });
        console.log("PERSISTENT speak done, identity:", room.localParticipant?.identity);
      });
    } else {
      // TRANSIENT: unique identity, serialize, and keep room up a tad longer
      const transientIdentity = `${BOT_IDENTITY}-t-${Math.random().toString(36).slice(2, 6)}`;
      console.log("TRANSIENT speak queued, identity:", transientIdentity);

      enqueueSpeak(async () => {
        const room = await connectToRoom(roomName0, transientIdentity);
        try {
          console.log("TRANSIENT speak starting, identity:", room.localParticipant?.identity);
          await speakTextIntoRoom(room, reply, { roomName: roomName0, identity: transientIdentity });
          console.log("TRANSIENT speak done, identity:", room.localParticipant?.identity);
          // keep the participant around briefly so late subscribers attach
          await new Promise((r) => setTimeout(r, 2000)); // was 800ms
        } finally {
          await room.disconnect().catch(() => {});
        }
      });
    }

    // respond right away
    return res.json({ ok: true, reply, mode });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// viewer token (subscribe-only)
app.get("/token", async (req, res) => {
  try {
    const roomName = String(req.query.room || DEFAULT_ROOM || "default");
    const identity = String(req.query.user || "viewer-" + Math.random().toString(36).slice(2, 8));
    const ttlMin = Number(CLIENT_TOKEN_TTL_MIN || 60);

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity,
      ttl: `${ttlMin}m`,
    });
    at.addGrant({ roomJoin: true, room: roomName, canPublish: false, canSubscribe: true });
    const jwt = await at.toJwt();
    res.type("text/plain").send(jwt);
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "token error" });
  }
});

// Simple TTS diag: returns { ok, bytes, ms } and serves the audio if you want to hear it
app.get("/diag/tts", async (req, res) => {
  try {
    const text = String(req.query.text || "This is a test.");
    const t0 = Date.now();
    const wavBuf = await ttsWavFromOpenAI(text);
    const ms = Date.now() - t0;
    res.json({ ok: true, bytes: wavBuf.length, ms, model: OPENAI_TTS_MODEL, voice: OPENAI_TTS_VOICE });
    // If you want to audition it in the browser instead, comment the line above and use:
    // res.type("audio/wav").send(wavBuf);
  } catch (e) {
    console.error("diag/tts error:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ── DIAGNOSTICS (tone/silence helpers still useful) ──────────────────────────
app.get("/diag/connect", async (_req, res) => {
  try {
    const room = await connectToRoom(DEFAULT_ROOM || "default");
    await room.disconnect();
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// short tone
app.post("/diag/tone", async (req, res) => {
  try {
    const roomName = req.body?.roomName || DEFAULT_ROOM || "default";
    const durationSec = Number(req.body?.durationSec ?? 2);
    const rate = 48000;
    const frameMs = 20;
    const samplesPerFrame = Math.floor((rate * frameMs) / 1000);
    const freq = Number(req.body?.freq ?? 440);
    const totalFrames = Math.ceil((durationSec * 1000) / frameMs);

    const room = await connectToRoom(roomName);

    const source = new AudioSource(rate, 1);
    const track = LocalAudioTrack.createAudioTrack("avatar-tone", source);
    const opts = new TrackPublishOptions();
    opts.source = TrackSource.SOURCE_MICROPHONE;
    const publication = await room.localParticipant.publishTrack(track, opts);

    let t = 0;
    const phaseInc = (2 * Math.PI * freq) / rate;
    for (let i = 0; i < totalFrames; i++) {
      const pcm = new Int16Array(samplesPerFrame);
      for (let n = 0; n < samplesPerFrame; n++) {
        const s = Math.sin(t) * 0.25;
        pcm[n] = s < 0 ? s * 0x8000 : s * 0x7fff;
        t += phaseInc;
      }
      const buf = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      const frame = new AudioFrame(buf, rate, 1, samplesPerFrame);
      await source.captureFrame(frame);
    }

    await new Promise((r) => setTimeout(r, 1000));
    await safeUnpublish(room, publication, track);
    try { if (typeof track.stop === "function") track.stop(); } catch {}
    try { if (typeof source.stop === "function") source.stop(); } catch {}
    await new Promise((r) => setTimeout(r, 300));
    await room.disconnect();

    res.json({ ok: true, roomName, freq, durationSec });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// long-hold tone (~20s)
app.post("/diag/tone_hold", async (req, res) => {
  try {
    const roomName = req.body?.roomName || DEFAULT_ROOM || "default";
    const rate = 48000;
    const frameMs = 20;
    const samplesPerFrame = Math.floor((rate * frameMs) / 1000);
    const freq = Number(req.body?.freq ?? 440);
    const holdMs = Number(req.body?.holdMs ?? 20000);

    const room = await connectToRoom(roomName);

    const source = new AudioSource(rate, 1);
    const track = LocalAudioTrack.createAudioTrack("avatar-tone-hold", source);
    const opts = new TrackPublishOptions();
    opts.source = TrackSource.SOURCE_MICROPHONE;
    const publication = await room.localParticipant.publishTrack(track, opts);

    let running = true;
    (async () => {
      let t = 0;
      const phaseInc = (2 * Math.PI * freq) / rate;
      while (running) {
        const pcm = new Int16Array(samplesPerFrame);
        for (let n = 0; n < samplesPerFrame; n++) {
          const s = Math.sin(t) * 0.2;
          pcm[n] = s < 0 ? s * 0x8000 : s * 0x7fff;
          t += phaseInc;
        }
        const buf = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
        const frame = new AudioFrame(buf, rate, 1, samplesPerFrame);
        await source.captureFrame(frame);
      }
    })();

    setTimeout(async () => {
      try {
        running = false;
        await new Promise((r) => setTimeout(r, 200));
        await safeUnpublish(room, publication, track);
        try { if (typeof track.stop === "function") track.stop(); } catch {}
        try { if (typeof source.stop === "function") source.stop(); } catch {}
        await new Promise((r) => setTimeout(r, 300));
        await room.disconnect();
      } catch (e) {
        console.warn("tone_hold cleanup failed:", e?.message || e);
      }
    }, holdMs);

    res.json({ ok: true, roomName, freq, holdMs });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// long-hold silence (~20s)
app.post("/diag/silence_hold", async (req, res) => {
  try {
    const roomName = req.body?.roomName || DEFAULT_ROOM || "default";
    const rate = 48000;
    const frameMs = 20;
    const samplesPerFrame = Math.floor((rate * frameMs) / 1000);
    const holdMs = Number(req.body?.holdMs ?? 20000);

    const room = await connectToRoom(roomName);

    const source = new AudioSource(rate, 1);
    const track = LocalAudioTrack.createAudioTrack("avatar-silence-hold", source);
    const opts = new TrackPublishOptions();
    opts.source = TrackSource.SOURCE_MICROPHONE;
    const publication = await room.localParticipant.publishTrack(track, opts);

    let running = true;
    (async () => {
      while (running) {
        const pcm = new Int16Array(samplesPerFrame);
        const buf = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
        const frame = new AudioFrame(buf, rate, 1, samplesPerFrame);
        await source.captureFrame(frame);
      }
    })();

    setTimeout(async () => {
      try {
        running = false;
        await new Promise((r) => setTimeout(r, 200));
        await safeUnpublish(room, publication, track);
        try { if (typeof track.stop === "function") track.stop(); } catch {}
        try { if (typeof source.stop === "function") source.stop(); } catch {}
        await new Promise((r) => setTimeout(r, 300));
        await room.disconnect();
      } catch (e) {
        console.warn("silence_hold cleanup failed:", e?.message || e);
      }
    }, holdMs);

    res.json({ ok: true, roomName, holdMs });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Audition the TTS WAV directly in the browser: /diag/tts.wav?text=Hello
app.get("/diag/tts.wav", async (req, res) => {
  try {
    const text = String(req.query.text || "This is a test.");
    const wavBuf = await ttsWavFromOpenAI(text);
    res.type("audio/wav").send(wavBuf);
  } catch (e) {
    console.error("diag/tts.wav error:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});


// ── START ─────────────────────────────────────────────────────────────────────
const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`avatarbot_service listening on ${port}`));
