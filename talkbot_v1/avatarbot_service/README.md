# avatarbot_service

## Env
Copy .env.example to .env and fill in:
- LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET
- OPENAI_API_KEY
- PIPER_URL
- DEFAULT_ROOM (optional)
- BOT_MODE=TRANSIENT or PERSISTENT

## Endpoints
POST /message  { roomName?, text, keep? } -> { ok, reply, mode }
POST /join     { roomName? }               -> persistent connect
POST /leave                                -> persistent disconnect
POST /mode     { mode: "TRANSIENT"|"PERSISTENT" }
GET  /healthz

## Examples
curl -X POST http://localhost:8080/message \
  -H "content-type: application/json" \
  -d '{"roomName":"demo","text":"Introduce yourself in 10 seconds.","keep":true}'


### For avatarbot_service
git init
git remote add origin https://github.com/<iamshacky>/avatarbot_service.git
git checkout -b main

# Create .gitignore (see below), add files:
git add .
git commit -m "avatarbot v1: bot + token server"
git push -u origin main

### For piper_service
git init
git remote add origin https://github.com/<iamshacky>/piper_service.git
git checkout -b main

# Create .gitignore (see below), add files:
git add .
git commit -m "avatarbot v1: bot + token server"
git push -u origin main