import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.get('/api/tts', async (req, res) => {
  try {
    const text  = String(req.query.text || 'Hello there!');
    const model = String(req.query.model || 'gpt-4o-mini-tts');
    const voice = String(req.query.voice || 'alloy');
    const fmt   = String(req.query.fmt || 'wav'); // 'wav' or 'mp3'
    const rate  = Number(req.query.rate || 24000); // 24000 is clean and small

    const resp = await openai.audio.speech.create({
      model,
      voice,
      input: text,
      response_format: fmt,    // 'wav' or 'mp3'
      sample_rate: rate
    });

    const buf = Buffer.from(await resp.arrayBuffer());
    res.set('Content-Type', fmt === 'mp3' ? 'audio/mpeg' : 'audio/wav');
    res.send(buf);
  } catch (e) {
    console.error('tts error:', e);
    res.status(500).json({ ok:false, error: String(e) });
  }
});

app.use(express.static('public'));
const port = process.env.PORT || 8080;
app.listen(port, () => console.log('avatar server on', port));
