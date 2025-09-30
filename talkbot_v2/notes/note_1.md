Awesome—glad it’s talking 🎉

Here are solid “next steps” you can pick from. I’d start with (A), then (B).

## A) Provider switching end-to-end (OpenAI now, add Microsoft/Piper later)

Goal: make the Provider `<select>` actually swap backends with zero client changes.

1. **Confirm wiring**
   Your `routes/tts.js` should already read `?provider=` and call `getTTSProvider(name)`. If so, you’re basically done for OpenAI.

2. **Add a second provider (stub)**

   * Create `tts/providers/microsoft.js` with a `speak(text, { voiceId, format, sampleRate })` export. Inside: TODOs + credential reads.
   * Register it in `tts/index.js` (e.g., `const providers = { openai, microsoft }`).
   * Add `Microsoft` to the Provider `<select>` in `public/index.html`.
   * Test `/api/tts?text=hello&provider=microsoft` (should return 501/Not Implemented or a clear error until creds are added).
   * When you’re ready, flesh out the call to Azure TTS (Cognitive Services).

3. **Config-first defaults**

   * In `config/default.json`, set `"tts.defaultProvider": "openai"`.
   * Verify `routes/tts.js` uses the config default when `?provider` is absent.

This nails the “interchangeable voices/services” goal without touching the avatar code.

## B) Lip-sync polish (still analyser-based, smoother)

* In `audio/outputs/webAudioPlayer.js`, set `analyser.smoothingTimeConstant = 0.7` (already in your file, keep it).
* In `avatar/core/controller.js`, switch from averaging “all bins” to **band-limited RMS** (≈ 200–4000 Hz) and map RMS → mouth openness with a little **attack/decay** to remove choppiness.
* Optional: map energy buckets to 3–5 **coarse visemes** (MBP / AI / E / O / rest) so the mouth shape looks more speech-like even before we have phoneme timings.

If you want, I’ll drop a tiny controller patch for RMS + attack/decay (1–2 functions).

## C) Diagnostics overlay (helps when you add more providers)

* Add a tiny status line to the page: last TTS RTT, audio “playing/buffered/ended”, current provider.
* Server: keep `/healthz`. Later, add `X-Request-Id` in responses for log correlation.

## D) Production hygiene (Railway)

* Create `config/production.json` (flip defaults: `format: "mp3"`, sampleRate 24000, OpenAI provider).
* Ensure `.env` is not in git; set `OPENAI_API_KEY` in Railway’s env.
* Add a simple smoke script (`scripts/smoke.sh`) and run it locally; later, make it a Railway post-deploy check.

## E) LLM adapter skeleton (future-proof, optional now)

* Add `llms/index.js` with a `getLLMProvider(name)` and a stub provider (openai/gemini).
* Expose a minimal `/api/llm` that returns a text string; the client can then `await fetch('/api/llm')` → pass text to TTS.
  (Keeps “brain” separate from “voice”.)

## F) Path stability (what you referenced)

You’re currently importing with absolute paths:

```js
import { WebAudioPlayer } from '/audio/outputs/webAudioPlayer.js';
import { AvatarController } from '/avatar/core/controller.js';
import { Dom2DRenderer } from '/avatar/renderers/dom2d.js';
```

That’s great for now. Later, you can add an **import map** to alias these (e.g., `/audio` → `/static/audio`) without changing every import.

---

### My recommended order

1. **A. Provider switching + Microsoft stub** (no behavior change for OpenAI, but unlocks swapping).
2. **B. Lip-sync polish** (quick visual win).
3. **C. Diagnostics overlay** (helps as you add providers).
4. **D. Production config** (smoother deploys).

Tell me which track you want first and I’ll give you the exact files/diffs.
