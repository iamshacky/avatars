import { Router } from 'express';
import { getTTSProvider } from '../../tts/index.js';
// import defaultCfg from '../../config/default.json' assert { type: 'json' };
import defaultCfg from '../../config/default.json' with { type: 'json' };

export const ttsRoute = Router();

ttsRoute.get('/', async (req, res, next) => {
  try {
    const text  = String(req.query.text || 'Hello there!');
    const voice = String(req.query.voice || defaultCfg.tts.defaultVoice);
    const fmt   = String(req.query.fmt   || defaultCfg.tts.format);     // 'wav'|'mp3'
    const rate  = Number(req.query.rate  || defaultCfg.tts.sampleRate); // 24000/48000
    const prov  = String(req.query.provider || defaultCfg.tts.defaultProvider);

    const provider = getTTSProvider(prov);
    const { buffer, mime } = await provider.speak(text, { voiceId: voice, format: fmt, sampleRate: rate });

    res.set('Content-Type', mime);
    res.set('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});
