import "dotenv/config";
import express from "express";
import fetch from "node-fetch";

// LiveKit Agents SDK
import { Room, trackFromFile } from "@livekit/agents";
import { OpenAI } from "@livekit/agents-plugin-openai";

import cors from "cors";
import { AccessToken } from "livekit-server-sdk";

app.use(cors()); // allow all origins for now; lock this down later if you like

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
app.use(express.json());

let persistent = null; // { room: Room } when connected persistently

async function connectToRoom(roomName, identity = BOT_IDENTITY) {
  const room = new Room();
  await room.connect(LIVEKIT_URL, {
    autoSubscribe: false,
    apiKey: LIVEKIT_API_KEY,
    apiSecret: LIVEKIT_API_SECRET,
    identity,
    // if you wish to pin to a room when connecting via Agents SDK:
    // NOTE: some versions join using server API; this identity will appear in that room on publish.
  });
  // If a specific room name is required by your LiveKit Cloud project routing,
  // you can keep DEFAULT_ROOM as a convention for your environment/workflow.
  return room;
}

async function speakTextIntoRoom(room, text) {
  // 1) TTS to WAV
  const tts = await fetch(`${PIPER_URL}/synthesize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text })
  });
  if (!tts.ok) throw new Error(`Piper error: ${tts.status}`);
  const wavBuf = Buffer.from(await tts.arrayBuffer());

  // 2) Publish audio track
  const track = await trackFromFile(wavBuf, { mimeType: "audio/wav" });
  await room.localParticipant.publishTrack(track, { name: "avatar-audio" });

  // Allow pipeline to flush slightly
  await new Promise(r => setTimeout(r, 500));
}

async function llmReply(userText) {
  const client = new OpenAI({ apiKey: OPENAI_API_KEY });
  const res = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "You are AvatarBot: concise, friendly, YouTube-presenter energy. Keep answers under 15 seconds unless asked." },
      { role: "user", content: userText }
    ]
  });
  return res.choices[0].message.content;
}

// ---- HTTP Endpoints ----

// Health
app.get("/healthz", (_, res) => res.json({ ok: true, mode: BOT_MODE, room: DEFAULT_ROOM }));

// Toggle mode at runtime (optional)
app.post("/mode", (req, res) => {
  const { mode } = req.body || {};
  if (mode && ["TRANSIENT", "PERSISTENT"].includes(mode)) {
    process.env.BOT_MODE = mode;
    res.json({ ok: true, mode });
  } else {
    res.status(400).json({ ok: false, error: "mode must be TRANSIENT or PERSISTENT" });
  }
});

// Join/leave for persistent mode
app.post("/join", async (req, res) => {
  const roomName = req.body?.roomName || DEFAULT_ROOM;
  if (persistent?.room) {
    return res.json({ ok: true, info: "already connected" });
  }
  try {
    const room = await connectToRoom(roomName);
    persistent = { room };
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

// Main: send a message for the bot to say
app.post("/message", async (req, res) => {
  const roomName = req.body?.roomName || DEFAULT_ROOM;
  const textIn = String(req.body?.text || "").trim();
  const keep = req.body?.keep; // optional per-request override

  if (!textIn) return res.status(400).json({ ok: false, error: "text required" });

  const mode = (keep === true || keep === false)
    ? (keep ? "PERSISTENT" : "TRANSIENT")
    : (process.env.BOT_MODE || BOT_MODE);

  try {
    const reply = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are AvatarBot: concise, friendly, YouTube-presenter energy. Keep answers under 15 seconds unless asked." },
        { role: "user", content: userText }  // or text
      ]
    });

    if (mode === "PERSISTENT") {
      if (!persistent?.room) {
        const room = await connectToRoom(roomName);
        persistent = { room };
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

app.get("/token", async (req, res) => {
  try {
    const roomName = String(req.query.room || process.env.DEFAULT_ROOM || "demo");
    const identity = String(req.query.user || "viewer-" + Math.random().toString(36).slice(2, 8));
    const ttlMin = Number(process.env.CLIENT_TOKEN_TTL_MIN || 60);

    const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
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
