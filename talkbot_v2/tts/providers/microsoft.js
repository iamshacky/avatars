// tts/providers/microsoft.js
// Contract: speak(text, { voiceId, format, sampleRate }) → { buffer, mime }
// This is a STUB so provider switching works end-to-end.
// Later we’ll wire Azure Cognitive Services or Piper here.

export async function speak(text, { voiceId = 'en-US-JennyNeural', format = 'mp3', sampleRate = 24000 } = {}) {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;

  const e = new Error(
    !key || !region
      ? 'Microsoft TTS not configured. Set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION.'
      : 'Microsoft TTS provider not implemented yet.'
  );
  e.status = 501; // Not Implemented
  throw e;

  // ——— Outline for later (REST) ———
  // 1) Get token:
  // POST https://{region}.api.cognitive.microsoft.com/sts/v1.0/issueToken (Ocp-Apim-Subscription-Key: key)
  // 2) POST SSML to https://{region}.tts.speech.microsoft.com/cognitiveservices/v1
  //    Headers:
  //     - Authorization: Bearer {token}
  //     - Content-Type: application/ssml+xml
  //     - X-Microsoft-OutputFormat: audio-24khz-96kbitrate-mono-mp3 (map from {format, sampleRate})
  //    Body: <speak> with <voice name="{voiceId}">{text}</voice>
  // 3) Return { buffer: Buffer.from(await resp.arrayBuffer()), mime: 'audio/mpeg' }
}
