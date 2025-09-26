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
//import { decode } from "node-wav";

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

function parseWav(buf) {
  // Minimal RIFF/WAVE parser with chunk walk & clamping
  if (buf.length < 44) throw new Error("WAV too short");
  if (buf.toString("ascii", 0, 4) !== "RIFF") throw new Error("Not RIFF");
  if (buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("Not WAVE");

  let offset = 12;
  let audioFormat = null;
  let numChannels = null;
  let sampleRate = null;
  let bitsPerSample = null;
  let dataStart = null;
  let dataLen = null;

  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === "fmt ") {
      if (size < 16) throw new Error("fmt chunk too small");
      audioFormat = buf.readUInt16LE(body + 0);   // 1=PCM, 3=IEEE float
      numChannels = buf.readUInt16LE(body + 2);
      sampleRate  = buf.readUInt32LE(body + 4);
      bitsPerSample = buf.readUInt16LE(body + 14);
    } else if (id === "data") {
      dataStart = body;
      dataLen = size;
      break; // take first data chunk
    }
    // word align
    offset = body + size + (size & 1);
  }

  if (!audioFormat || !numChannels || !sampleRate || !bitsPerSample) {
    throw new Error("WAV missing fmt fields");
  }
  if (dataStart == null || dataLen == null) {
    throw new Error("WAV missing data chunk");
  }

  // Clamp if encoder lied about size
  if (dataStart + dataLen > buf.length) {
    dataLen = Math.max(0, buf.length - dataStart);
  }

  const dataBuf = buf.slice(dataStart, dataStart + dataLen);
  return { audioFormat, numChannels, sampleRate, bitsPerSample, dataBuf };
}

function toMonoInt16({ audioFormat, numChannels, bitsPerSample, dataBuf }) {
  // Support PCM16 (format=1, bps=16) and Float32 (format=3, bps=32)
  if (audioFormat === 1 && bitsPerSample === 16) {
    const i16 = new Int16Array(dataBuf.buffer, dataBuf.byteOffset, dataBuf.byteLength / 2);
    if (numChannels === 1) return i16;

    // downmix any N channels to mono (average)
    const frames = Math.floor(i16.length / numChannels);
    const out = new Int16Array(frames);
    for (let f = 0; f < frames; f++) {
      let acc = 0;
      for (let c = 0; c < numChannels; c++) {
        acc += i16[f * numChannels + c];
      }
      out[f] = acc / numChannels;
    }
    return out;
  }

  if (audioFormat === 3 && bitsPerSample === 32) {
    const f32 = new Float32Array(dataBuf.buffer, dataBuf.byteOffset, dataBuf.byteLength / 4);
    if (numChannels === 1) {
      const out = new Int16Array(f32.length);
      for (let i = 0; i < f32.length; i++) {
        const s = Math.max(-1, Math.min(1, f32[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      return out;
    }
    const frames = Math.floor(f32.length / numChannels);
    const out = new Int16Array(frames);
    for (let f = 0; f < frames; f++) {
      let acc = 0;
      for (let c = 0; c < numChannels; c++) {
        acc += f32[f * numChannels + c];
      }
      const s = Math.max(-1, Math.min(1, acc / numChannels));
      out[f] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  throw new Error(`Unsupported WAV format: format=${audioFormat} bits=${bitsPerSample} ch=${numChannels}`);
}

function resampleTo48kInt16(srcI16, srcRate) {
  const dstRate = 48000;
  if (srcRate === dstRate) return srcI16;
  const ratio = dstRate / srcRate;
  const dstLen = Math.max(1, Math.round(srcI16.length * ratio));
  const out = new Int16Array(dstLen);
  for (let i = 0; i < dstLen; i++) {
    const x = i / ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, srcI16.length - 1);
    const s0 = srcI16[i0];
    const s1 = srcI16[i1];
    out[i] = s0 + (s1 - s0) * (x - i0);
  }
  return out;
}

// ── AUDIO: WAV → 48k PCM FRAMES ───────────────────────────────────────────────
async function wavToInt16Frames(wavBuf, desiredFrameMs = 20) {
  const meta = parseWav(wavBuf);
  const monoI16 = toMonoInt16(meta);
  const i16_48k = resampleTo48kInt16(monoI16, meta.sampleRate);

  // 20ms framing with padding
  const rate = 48000;
  const samplesPerFrame = Math.floor((rate * desiredFrameMs) / 1000); // 960
  const frames = [];

  for (let offset = 0; offset < i16_48k.length; offset += samplesPerFrame) {
    const remain = Math.min(samplesPerFrame, i16_48k.length - offset);
    let block;
    if (remain === samplesPerFrame) {
      block = i16_48k.subarray(offset, offset + samplesPerFrame);
    } else {
      block = new Int16Array(samplesPerFrame);
      block.set(i16_48k.subarray(offset, offset + remain), 0);
    }
    frames.push({
      buf: Buffer.from(block.buffer, block.byteOffset, block.byteLength),
      sampleRate: rate,
      samplesPerChannel: samplesPerFrame,
      numChannels: 1
    });
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

  // Small grace so SFU announces the track before audio starts
  await new Promise((r) => setTimeout(r, 120));

  const frameMs = 20;
  const samplesPerFrame = Math.floor((sampleRate * frameMs) / 1000); // 960 @ 48k

  // Build a playlist: short pre-roll silence → actual TTS frames → short tail
  const preMs = 400;   // try 200–600ms if you like
  const tailMs = 600;  // try 400–1000ms if you like

  const silentBlock = new Int16Array(samplesPerFrame);
  const silentBuf = Buffer.from(silentBlock.buffer, silentBlock.byteOffset, silentBlock.byteLength);

  // Wrap frames into a uniform descriptor
  const playlist = [];

  for (let i = 0; i < Math.ceil(preMs / frameMs); i++) {
    playlist.push({ buf: silentBuf, samplesPerChannel: samplesPerFrame, silent: true });
  }

  for (const f of frames) {
    playlist.push({ buf: f.buf, samplesPerChannel: f.samplesPerChannel, silent: false });
  }

  for (let i = 0; i < Math.ceil(tailMs / frameMs); i++) {
    playlist.push({ buf: silentBuf, samplesPerChannel: samplesPerFrame, silent: true });
  }

  console.log("About to publish frames", {
    by: room?.localParticipant?.identity,
    totalFrames: playlist.length,
    sampleRate,
    samplesPerFrame,
  });

    // Pace frames in real time (~20ms per frame)
  const t0 = Date.now();
  let i = 0;
  for (const item of playlist) {
    // ⬇️ IMPORTANT: use the *actual* per-item sample count
    const spp = item.samplesPerChannel;           // was: samplesPerFrame
    const frame = new AudioFrame(item.buf, sampleRate, 1, spp);
    await source.captureFrame(frame);

    // realtime pacing
    const target = t0 + (++i * frameMs);
    const wait = target - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  // (Optional) quick RMS on the last *non-silent* frame for sanity
  try {
    const lastAudio = frames[frames.length - 1];
    if (lastAudio?.buf?.byteLength) {
      const i16 = new Int16Array(lastAudio.buf.buffer, lastAudio.buf.byteOffset, lastAudio.buf.byteLength / 2);
      let sum = 0;
      for (let k = 0; k < i16.length; k++) { const v = i16[k] / 32768; sum += v * v; }
      console.log("RMS(last audio frame):", Math.sqrt(sum / i16.length).toFixed(4));
    }
  } catch {}

  // Unpublish (use the simplest signature to avoid proto option issues)
  try {
    await room.localParticipant.unpublishTrack(track);
  } catch (e) {
    console.warn("unpublishTrack warn:", e?.message || e);
  }

  try { track.stop?.(); } catch {}
  try { source.stop?.(); } catch {}
}

async function speakTextIntoRoom(roomOrName, text, opts = {}) {
  console.log("[speakTextIntoRoom] entered with text:", text.slice(0,50));
  try {
    const wavBuf = await ttsWavFromOpenAI(text);
    try {
      const dv = new DataView(wavBuf.buffer, wavBuf.byteOffset, Math.min(64, wavBuf.byteLength));
      const tag = Buffer.from(wavBuf.slice(0, 12)).toString("ascii");
      console.log("[tts header]", tag);
    } catch {}
    console.log("[speakTextIntoRoom] got wavBuf len:", wavBuf.length);
    const { frames, sampleRate } = await wavToInt16Frames(wavBuf, 20);
    console.log("[speakTextIntoRoom] got frames:", frames.length, "sr:", sampleRate);

    let room = typeof roomOrName === "string"
      ? await ensurePersistentRoom(roomOrName)
      : roomOrName;
    console.log("[speakTextIntoRoom] using room:", room?.localParticipant?.identity);

    await publishFramesOnce(room, frames, sampleRate);
    console.log("[speakTextIntoRoom] publishFramesOnce finished");
  } catch (e) {
    console.error("[speakTextIntoRoom] error:", e);
    throw e;
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
