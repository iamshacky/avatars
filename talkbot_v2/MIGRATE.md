1) Copy talkbot_v2/ to your repo alongside talkbot_v1/.
2) Create .env from .env.example and set OPENAI_API_KEY.
3) npm i
4) npm run dev
5) Visit http://localhost:8080 — behavior should match v1 (OpenAI TTS + mouth).
6) Deploy to Railway (auto PORT handling). Optionally add production.json overrides.

Later:
- Add a new provider file in tts/providers/, export speak().
- Register it in tts/index.js, then it appears in ?provider=NAME.
- Swap renderer or add LLMs under llms/providers/ without touching the avatar.
