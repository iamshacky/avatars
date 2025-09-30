talkbot_v2

Contracts:
- TTS Provider v1 (speak(text, { voiceId, format, sampleRate }) → { buffer, mime })
- TTS HTTP API v1: GET /api/tts?text&voice&fmt&rate&provider
- Avatar API v1 (energy-based): controller.update() + renderer.setMouthOpen()
- Renderer DOM2D v1
Notes:
- Config via config/default.json (non-secrets)
- Secrets via .env (OPENAI_API_KEY)
