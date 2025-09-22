import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import OpenAI from "openai";
import { AccessToken } from "livekit-server-sdk";

// Server-side WebRTC client for LiveKit
import { Room, LocalAudioTrack, WavFileSource } from "@livekit/rtc-node";

const {
  LIVEKIT_URL,
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET,
  OPENAI_API_KEY,
  PIPER_URL,
  DEFAULT_ROOM = "demo",
  BOT_IDENTITY = "AvatarBot",
  BOT_MODE = "TRANSIENT" // or PERSISTENT
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
app.use(cors());
app.use(express.json());

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

let persistent = null; // { room: Room, identity: string, roomName: string }

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
  await room.connect(LIVEKIT_URL, await token);
  return room;
}

async function speakTextIntoRoom(room, text) {
  // 1) TTS to WAV (buffer)
  const tts = await fetch(`${PIPER_URL}/synthesize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text })
  });
  if (!tts.ok) throw new Error(`Piper error: ${tts.status}`);
  const wavBuf = Buffer.from(await tts.arrayBuffer());

  // 2) Save to temp .wav (WavFileSource expects a file path)
  const tmp = await import("tmp");
  const tmpFile = tmp.fileSync({ postfix: ".wav" });
  await import("fs").then(({ writeFileSync }) => writeFileSync(tmpFile.name, wavBuf));

  // 3) Create audio source & track, publish
  const source = await WavFileSource.fromFile(tmpFile.name);
  const track = LocalAudioTrack.createAudioTrack("avatar-audio", {
    source, // feed WAV frames into the track
  });
  await room.localParticipant.publishTrack(track);

  // Let audio pipeline flush a bit
  await new Promise((r) => setTimeout(r, 500));

  // Cleanup temp file
  tmpFile.removeCallback?.();
}

async function llmReply(userText) {
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "You are AvatarBot: concise, friendly, YouTube-presenter energy. Keep answers under 15 seconds unless asked." },
      { role: "user", content: userText }
    ]
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
    persistent = { room, identity: BOT_IDENTITY, roomName };
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

  const mode = (keep === true || keep === false)
    ? (keep ? "PERSISTENT" : "TRANSIENT")
    : (process.env.BOT_MODE || BOT_MODE);

  try {
    const reply = await llmReply(textIn);

    if (mode === "PERSISTENT") {
      if (!persistent?.room) {
        const room = await connectToRoom(roomName);
        persistent = { room, identity: BOT_IDENTITY, roomName };
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

// Public client token for the viewer web page (subscribe-only)
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
      canPublish: false,   // viewer page subscribes only
      canSubscribe: true,
    });
    const jwt = await at.toJwt();
    res.type("text/plain").send(jwt);
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "token error" });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`avatarbot_service listening on ${port}`));
