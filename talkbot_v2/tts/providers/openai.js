import OpenAI from 'openai';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Contract: speak(text, { voiceId, format, sampleRate }) → { buffer, mime, timing? }
 */
export async function speak(text, { voiceId = 'alloy', format = 'mp3', sampleRate = 24000 } = {}) {
  const resp = await client.audio.speech.create({
    model: 'gpt-4o-mini-tts',
    voice: voiceId,
    input: text,
    response_format: format,   // 'wav' | 'mp3'
    sample_rate: sampleRate
  });

  const buf = Buffer.from(await resp.arrayBuffer());
  const mime = format === 'mp3' ? 'audio/mpeg' : 'audio/wav';
  return { buffer: buf, mime };
}
