import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
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
// import { decode } from "wav-decoder";
import { decode } from "node-wav";

const {
  LIVEKIT_URL,
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET,
  OPENAI_API_KEY,
  PIPER_URL,
  DEFAULT_ROOM = "demo",
  BOT_IDENTITY = "AvatarBot",
  BOT_MODE = "TRANSIENT", // or PERSISTENT
} = process.env;

if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  console.error("Missing LiveKit env vars.");
  process.exit(1);
}
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY.");
  process.exit(1);
}
if (!PIPER_URL) {
  console.error("Missing PIPER_URL.");
  process.exit(1);
}

const app = express();
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pubDir = path.join(__dirname, "public");

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.get("/__debug/files", (_req, res) => {
  let exists = fs.existsSync(pubDir);
  let listing = exists ? fs.readdirSync(pubDir) : [];
  res.json({ __dirname, pubDir, exists, listing });
});

// 🔐 simple shared-secret gate for write endpoints
app.use((req, res, next) => {
  const needsAuth =
    req.method === "POST" &&
    ["/message", "/join", "/leave", "/mode"].includes(req.path);
  if (!needsAuth) return next();

  const provided = req.headers["x-bot-auth"];
  if (!process.env.BOT_AUTH || provided === process.env.BOT_AUTH) return next();

  return res.status(401).json({ ok: false, error: "unauthorized" });
});

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

let persistent = null; // { room: Room, roomName: string }

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

async function connectToRoom(roomName, identity = BOT_IDENTITY) {
  const room = new Room();
  const token = await mintServerToken({ roomName, identity, canPublish: true });
  try {
    await room.connect(LIVEKIT_URL, token);
    return room;
  } catch (e) {
    console.error("LiveKit connect failed", {
      url: LIVEKIT_URL,
      roomName,
      identity,
      iss: (process.env.LIVEKIT_API_KEY || "").slice(0, 4) + "…",
      msg: String(e)
    });
    throw e;
  }
}

async function wavToInt16Frames(wavBuf, desiredFrameMs = 20) {
  // decode WAV -> Float32 PCM
  const { sampleRate, channelData } = await decode(wavBuf);
  const channels = channelData.length;
  const ch0 = channelData[0]; // Float32Array [-1,1]
  // For mono, great; if stereo, downmix simple average for now
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

  // convert to int16
  const pcm16 = new Int16Array(mono.length);
  for (let i = 0; i < mono.length; i++) {
    const s = Math.max(-1, Math.min(1, mono[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }

  // split into 20ms frames (or desiredFrameMs)
  const samplesPerFrame = Math.floor((sampleRate * desiredFrameMs) / 1000);
  const frames = [];
  for (let offset = 0; offset < pcm16.length; offset += samplesPerFrame) {
    const slice = pcm16.subarray(offset, Math.min(offset + samplesPerFrame, pcm16.length));
    // AudioFrame expects interleaved int16 bytes (num_channels=1 here)
    const buf = Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength);
    frames.push({ buf, sampleRate, samplesPerChannel: slice.length, numChannels: 1 });
  }
  return { frames, sampleRate, channels: 1 };
}

async function speakTextIntoRoom(room, text) {
  // 1) Get WAV from Piper
  const tts = await fetch(`${PIPER_URL}/synthesize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!tts.ok) throw new Error(`Piper error: ${tts.status}`);
  const wavBuf = Buffer.from(await tts.arrayBuffer());

  // 2) Decode to PCM frames
  const { frames, sampleRate } = await wavToInt16Frames(wavBuf, 20);

    // 3) Create source/track and publish
  const source = new AudioSource(sampleRate, 1);
  const track = LocalAudioTrack.createAudioTrack("avatar-audio", source);

  const options = new TrackPublishOptions();
  options.source = TrackSource.SOURCE_MICROPHONE;

  //await room.localParticipant.publishTrack(track, options);
  const pub = await room.localParticipant.publishTrack(track, options);

  // 4) Push frames
  for (const f of frames) {
    const frame = new AudioFrame(f.buf, f.sampleRate, f.numChannels, f.samplesPerChannel);
    await source.captureFrame(frame);
  }

  // small drain so last frames flush
  await new Promise((r) => setTimeout(r, 200));

  // ✅ unpublish and stop: make sure we pass the SID field available on this SDK version
  if (sid) await room.localParticipant.unpublishTrack(sid, { stopOnUnpublish: true });


  if (typeof track.stop === "function") track.stop();
  if (typeof source.stop === "function") source.stop();
}

async function llmReply(userText) {
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "You are AvatarBot: concise, friendly, YouTube-presenter energy. Keep answers under 15 seconds unless asked." },
      { role: "user", content: userText },
    ],
  });
  return res.choices?.[0]?.message?.content ?? "Sorry, I couldn't think of anything to say.";
}

// ---- HTTP Endpoints ----

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, mode: process.env.BOT_MODE || BOT_MODE, room: DEFAULT_ROOM });
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

app.post("/join", async (req, res) => {
  const roomName = req.body?.roomName || DEFAULT_ROOM;
  if (persistent?.room) return res.json({ ok: true, info: "already connected" });
  try {
    const room = await connectToRoom(roomName);
    persistent = { room, roomName };
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

  const mode = keep === true || keep === false ? (keep ? "PERSISTENT" : "TRANSIENT") : (process.env.BOT_MODE || BOT_MODE);

  try {
    const reply = await llmReply(textIn);

    if (mode === "PERSISTENT") {
      if (!persistent?.room) {
        const room = await connectToRoom(roomName);
        persistent = { room, roomName };
      }
      await speakTextIntoRoom(persistent.room, reply);
    } else {
      const room = await connectToRoom(roomName);
      await speakTextIntoRoom(room, reply);
      await room.disconnect();
    }

    res.json({ ok: true, reply, mode });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Viewer token (subscribe-only)
app.get("/token", async (req, res) => {
  try {
    const roomName = String(req.query.room || process.env.DEFAULT_ROOM || "demo");
    const identity = String(req.query.user || "viewer-" + Math.random().toString(36).slice(2, 8));
    const ttlMin = Number(process.env.CLIENT_TOKEN_TTL_MIN || 60);

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity,
      ttl: `${ttlMin}m`,
    });
    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: false,
      canSubscribe: true,
    });
    const jwt = await at.toJwt();
    res.type("text/plain").send(jwt);
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "token error" });
  }
});

// 🔎 Piper health passthrough
app.get("/diag/piper", async (_req, res) => {
  try {
    const r = await fetch(`${PIPER_URL}/healthz`);
    res.json({ ok: r.ok, status: r.status });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// 🔎 LiveKit connect-only check
app.get("/diag/connect", async (_req, res) => {
  try {
    const room = await connectToRoom(process.env.DEFAULT_ROOM || "demo");
    await room.disconnect();
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`avatarbot_service listening on ${port}`));
