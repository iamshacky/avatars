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

function saveToPublicTemp(buf, ext = "wav") {
  const fname = `tts-${Date.now()}-${Math.random().toString(36).slice(2,8)}.${ext}`;
  const outPath = path.join(pubDir, fname);
  fs.writeFileSync(outPath, buf);
  return "/" + fname; // URL the browser can fetch
}

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

async function pcm48ToInt16Frames(pcmBuf48, desiredFrameMs = 20) {
  // pcmBuf48 is raw mono little-endian int16 @ 48 kHz
  if (!pcmBuf48 || pcmBuf48.length === 0) {
    throw new Error("PCM buffer empty");
  }
  // Interpret as Int16 samples
  const i16_48k = new Int16Array(pcmBuf48.buffer, pcmBuf48.byteOffset, pcmBuf48.byteLength / 2);

  // (Optional) normalization — reuse your existing block as-is:
  (function normalize(i16) {
    let peak = 0;
    for (let i = 0; i < i16.length; i++) {
      const v = Math.abs(i16[i]);
      if (v > peak) peak = v;
    }
    if (peak > 0 && peak < 12000) {
      const target = 0.8 * 32767;
      const scale = target / peak;
      for (let i = 0; i < i16.length; i++) {
        let s = i16[i] * scale;
        if (s >  32767) s =  32767;
        if (s < -32768) s = -32768;
        i16[i] = s | 0;
      }
    }
  })(i16_48k);

  const rate = 48000;
  const samplesPerFrame = Math.floor((rate * desiredFrameMs) / 1000); // 960
  const frames = [];

  for (let offset = 0; offset < i16_48k.length; offset += samplesPerFrame) {
    const remain = Math.min(samplesPerFrame, i16_48k.length - offset);
    let view;
    if (remain === samplesPerFrame) {
      view = i16_48k.subarray(offset, offset + samplesPerFrame);
    } else {
      const pad = new Int16Array(samplesPerFrame);
      pad.set(i16_48k.subarray(offset, offset + remain), 0);
      view = pad;
    }

    const buf = Buffer.allocUnsafe(view.length * 2);
    for (let i = 0; i < view.length; i++) buf.writeInt16LE(view[i], i * 2);

    frames.push({ buf, sampleRate: rate, samplesPerChannel: samplesPerFrame, numChannels: 1 });
  }
  return { frames, sampleRate: rate, channels: 1 };
}

function wrapPcm16AsWav(pcmBuf, sampleRate = 48000, numChannels = 1) {
  const byteRate = sampleRate * numChannels * 2;
  const blockAlign = numChannels * 2;
  const dataSize = pcmBuf.length;
  const riffSize = 36 + dataSize;

  const header = Buffer.allocUnsafe(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(riffSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);          // PCM header size
  header.writeUInt16LE(1, 20);           // format = PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);          // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcmBuf]);
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
    const totalSamples = dataBuf.length / 2; // int16
    const frames = Math.floor(totalSamples / numChannels);
    const out = new Int16Array(frames);
    let o = 0;
    let off = 0;

    for (let f = 0; f < frames; f++) {
      let acc = 0;
      for (let c = 0; c < numChannels; c++) {
        const s = dataBuf.readInt16LE(off); // explicit little-endian
        acc += s;
        off += 2;
      }
      out[o++] = (acc / numChannels) | 0;
    }
    return out;
  }

  if (audioFormat === 3 && bitsPerSample === 32) {
    const totalSamples = dataBuf.length / 4; // float32
    const frames = Math.floor(totalSamples / numChannels);
    const out = new Int16Array(frames);
    let o = 0;
    let off = 0;

    for (let f = 0; f < frames; f++) {
      let acc = 0;
      for (let c = 0; c < numChannels; c++) {
        const s = dataBuf.readFloatLE(off); // explicit little-endian
        acc += s;
        off += 4;
      }
      const m = Math.max(-1, Math.min(1, acc / numChannels));
      out[o++] = m < 0 ? m * 0x8000 : m * 0x7fff;
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

  // Cubic Hermite interpolation (4-point). Safer than linear for sibilants.
  const read = (i) => {
    // clamp
    if (i < 0) return srcI16[0];
    if (i >= srcI16.length) return srcI16[srcI16.length - 1];
    return srcI16[i];
  };

  for (let i = 0; i < dstLen; i++) {
    const x = i / ratio;
    const i1 = Math.floor(x);
    const t = x - i1;

    const i0 = i1 - 1;
    const i2 = i1 + 1;
    const i3 = i1 + 2;

    const y0 = read(i0);
    const y1 = read(i1);
    const y2 = read(i2);
    const y3 = read(i3);

    // Cubic Hermite basis
    const a0 = -0.5*y0 + 1.5*y1 - 1.5*y2 + 0.5*y3;
    const a1 = y0 - 2.5*y1 + 2*y2 - 0.5*y3;
    const a2 = -0.5*y0 + 0.5*y2;
    const a3 = y1;

    let s = ((a0*t + a1)*t + a2)*t + a3;

    // clamp to int16
    if (s >  32767) s =  32767;
    if (s < -32768) s = -32768;
    out[i] = s | 0;
  }
  return out;
}

// ── AUDIO: WAV → 48k PCM FRAMES ───────────────────────────────────────────────
async function wavToInt16Frames(wavBuf, desiredFrameMs = 20) {
  const meta = parseWav(wavBuf);

  console.log("[wav] fmt", {
    format: meta.audioFormat,
    ch: meta.numChannels,
    sr: meta.sampleRate,
    bps: meta.bitsPerSample,
    bytes: meta.dataBuf?.length
  });

  // Decode to mono Int16
  const i16 = toMonoInt16(meta);
  const rate = meta.sampleRate;  // keep native (likely 24000)
  const samplesPerFrame = Math.floor((rate * desiredFrameMs) / 1000);
  const frames = [];
  for (let offset = 0; offset < i16.length; offset += samplesPerFrame) {
    const remain = Math.min(samplesPerFrame, i16.length - offset);
    let view;
    if (remain === samplesPerFrame) {
      view = i16.subarray(offset, offset + samplesPerFrame);
    } else {
      const pad = new Int16Array(samplesPerFrame);
      pad.set(i16.subarray(offset, offset + remain), 0);
      view = pad;
    }
    const buf = Buffer.allocUnsafe(view.length * 2);
    for (let k = 0; k < view.length; k++) {
      buf.writeInt16LE(view[k], k * 2);
    }
    frames.push({ buf, sampleRate: rate, samplesPerChannel: samplesPerFrame, numChannels: 1 });
  }
  return { frames, sampleRate: rate, channels: 1 };
}

// ── TTS (OpenAI) ─────────────────────────────────────────────────────────────
async function ttsWavFromOpenAI(text) {
  const t0 = Date.now();
  // Match the quality you liked from /diag/tts.wav (24k mono WAV).
  const resp = await openai.audio.speech.create({
    model: OPENAI_TTS_MODEL,
    voice: OPENAI_TTS_VOICE,
    response_format: "wav",
    sample_rate: 24000, // 24k sounds like your good sample
    input: text,
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
  options.dtx = false;
  options.red = true;
  options.audioBitrate = 48000;

  await room.localParticipant.publishTrack(track, options);

  await new Promise((r) => setTimeout(r, 150)); // small pre-roll

  const frameMs = 20;
  const samplesPerFrame = Math.floor((sampleRate * frameMs) / 1000);  // <-- derived, not 960 hard-coded

  // minimal pre/post padding
  const prePadFrames = 8;   // ~160 ms
  const postPadFrames = 8;  // ~160 ms
  const silent = Buffer.alloc(samplesPerFrame * 2); // int16 stereo? mono: 2 bytes/sample
  const playlist = [];

  for (let i = 0; i < prePadFrames; i++) {
    playlist.push({ buf: silent, samplesPerChannel: samplesPerFrame });
  }
  for (const f of frames) {
    playlist.push({ buf: f.buf, samplesPerChannel: samplesPerFrame });
  }
  for (let i = 0; i < postPadFrames; i++) {
    playlist.push({ buf: silent, samplesPerChannel: samplesPerFrame });
  }

  console.log("About to publish frames", {
    by: room?.localParticipant?.identity,
    totalFrames: playlist.length,
    sampleRate,
    samplesPerFrame,
  });

  const t0 = Date.now();
  let i = 0;
  for (const item of playlist) {
    const spp = item.samplesPerChannel;

    // IMPORTANT: 4-arg ctor (buffer, sampleRate, channels, samplesPerChannel)
    const frame = new AudioFrame(item.buf, sampleRate, 1, spp);   // <-- 4 args only
    await source.captureFrame(frame);

    // 20ms pacing
    const target = t0 + (++i * frameMs);
    const wait = target - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  await new Promise((r) => setTimeout(r, 200));
  try { await room.localParticipant.unpublishTrack(track); } catch {}
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
    
    let frames, sampleRate;
    const isRIFF = wavBuf.length >= 12
      && wavBuf.toString('ascii', 0, 4) === 'RIFF'
      && wavBuf.toString('ascii', 8, 12) === 'WAVE';

    if (isRIFF) {
      ({ frames, sampleRate } = await wavToInt16Frames(wavBuf, 20));
    } else {
      ({ frames, sampleRate } = await pcm48ToInt16Frames(wavBuf, 20)); // raw PCM @ 48k
    }

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
  if (!textIn) return res.status(400).json({ ok: false, error: "text required" });

  // We still compute a reply and make sure the avatar is present in the room,
  // but we won't publish any audio via LiveKit.
  try {
    const t0 = Date.now();
    const reply = await llmReply(textIn);
    console.log("LLM ms:", Date.now() - t0);

    // Ensure the avatar is "in the room" (presence) but stay muted: publish nothing.
    await ensurePersistentRoom(roomName);

    // Generate high-quality TTS and save it under /public
    const wavBuf = await ttsWavFromOpenAI(reply);
    const audioUrl = saveToPublicTemp(wavBuf, "wav");

    // Return URL so the browser can play it directly
    return res.json({ ok: true, reply, audioUrl, mode: "NO_LK_AUDIO" });
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
      const frame = new AudioFrame(buf, rate, 1, samplesPerFrame, 2);
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
        const frame = new AudioFrame(buf, rate, 1, samplesPerFrame, 2);
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
        const frame = new AudioFrame(buf, rate, 1, samplesPerFrame, 2);
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
    const buf = await ttsWavFromOpenAI(text);
    // Detect if buf is already WAV; if not, wrap as WAV
    const isRIFF = buf.length >= 12
      && buf.toString('ascii', 0, 4) === 'RIFF'
      && buf.toString('ascii', 8, 12) === 'WAVE';
    const out = isRIFF ? buf : wrapPcm16AsWav(buf, 48000, 1);
    res.type("audio/wav").send(out);
  } catch (e) {
    console.error("diag/tts.wav error:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});


// ── START ─────────────────────────────────────────────────────────────────────
const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`avatarbot_service listening on ${port}`));

